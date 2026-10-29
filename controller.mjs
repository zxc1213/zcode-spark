#!/usr/bin/env node
/*
ZCode Spark 控制器。

职责：
1. 以 --remote-debugging-port 拉起 ZCode 桌面版（不改安装目录、不碰签名）
2. 通过 CDP 向渲染进程注入 inject.js，并在页面刷新/新窗口后自动重注入
3. 接收页面请求：改写草稿（调用模型）与回填输入框（受信按键 + 受信插入）
4. 对外暴露配置读写、供应商/模型探测、连接测试

命令行：
  node controller.mjs              正常启动
  node controller.mjs --doctor     打印诊断信息后退出
  node controller.mjs --attach [port]  附着到已开调试端口的 ZCode（不负责拉起）
  node controller.mjs --version
*/
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  INSTALL_DIR, CONFIG_FILE, IS_WIN, applyClientPatch, ensureConfig, loadConfig, saveConfig, clientConfig,
  log, safeError,
} from "./lib/config.mjs";
import { CdpConnection } from "./lib/cdp.mjs";
import { callModel, listModels, testConnection } from "./lib/llm.mjs";
import { ACTIONS, actionMeta, renderPrompt } from "./lib/prompts.mjs";
import { localModels, normalizeBase, resolveAuto, scanProviders } from "./lib/providers.mjs";
import {
  activateZcode, askYesNo, cdpVersion, findFreePort, findZcodePath, isFile, killZcodeProcesses,
  notify, zcodeProcessesRunning,
} from "./lib/platform.mjs";

const VERSION = "0.1.0";
const BINDING = "__zcodeSpark";
const LOCK_FILE = path.join(INSTALL_DIR, "run.lock");
const REQUEST_TIMEOUT_MS = 90000;
const CDP_BOOT_TIMEOUT_MS = 60000;
const INJECT_FILE = path.join(INSTALL_DIR, "inject.js");

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const flagValue = (name) => {
  const index = args.indexOf(name);
  if (index < 0) return "";
  const next = args[index + 1];
  return next && !next.startsWith("--") ? next : "";
};

let cdp = null;
const activeRequests = new Map(); // requestId -> AbortController
const recentRuns = [];

function injectSource() {
  if (!isFile(INJECT_FILE)) throw new Error(`缺少 inject.js：${INJECT_FILE}`);
  const source = fs.readFileSync(INJECT_FILE, "utf8");
  return `globalThis.__zcodeSparkVersion = ${JSON.stringify(VERSION)};\n${source}\n`;
}

// ---- 单实例锁 ----
function acquireLock() {
  try {
    const pid = Number(fs.readFileSync(LOCK_FILE, "utf8").trim());
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 0); return pid; } catch {}
    }
  } catch {}
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  fs.writeFileSync(LOCK_FILE, String(process.pid), "utf8");
  return null;
}
function releaseLock() {
  try {
    if (Number(fs.readFileSync(LOCK_FILE, "utf8").trim()) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch {}
}

// ---- 连接参数解析 ----
function connectionFor(msg = {}) {
  const cfg = loadConfig();
  const allowLocal = cfg.llm.allowLocal !== false;
  if (cfg.llm.mode === "manual") {
    if (!cfg.llm.baseUrl) throw new Error("手动模式还没有填 Base URL，打开设置补上");
    if (!cfg.llm.apiKey) throw new Error("手动模式还没有填 API Key，打开设置补上");
    if (!cfg.llm.model) throw new Error("手动模式还没有填模型名，打开设置补上");
    return {
      mode: "manual",
      providerId: "manual",
      providerName: "手动连接",
      baseUrl: normalizeBase(cfg.llm.baseUrl, { allowLocal }),
      apiKey: cfg.llm.apiKey,
      model: cfg.llm.model,
      protocol: cfg.llm.protocol,
      headers: {},
    };
  }
  return resolveAuto({
    providerId: cfg.llm.providerId,
    model: cfg.llm.model,
    modelLabel: msg.modelLabel,
    workspacePaths: msg.workspacePaths,
    allowLocal,
  });
}

function publicConnection(cfg) {
  return {
    mode: cfg.mode,
    providerId: cfg.providerId,
    providerName: cfg.providerName,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    protocol: cfg.protocol,
  };
}

function pushRun(entry) {
  recentRuns.unshift(entry);
  if (recentRuns.length > 8) recentRuns.length = 8;
}

// ---- 页面请求分发 ----
async function handleBinding(sessionId, payload) {
  let msg;
  try { msg = JSON.parse(payload); } catch { return; }
  const id = Number(msg?.id);
  if (!Number.isFinite(id)) return;
  const reply = (data) => cdp?.reply(sessionId, id, data);

  try {
    switch (msg.type) {
      case "hello": {
        reply({ ok: true, version: VERSION, config: clientConfig(loadConfig()), actions: ACTIONS.map(({ id, label, hint }) => ({ id, label, hint })) });
        return;
      }
      case "config": {
        reply({ ok: true, config: clientConfig(loadConfig()) });
        return;
      }
      case "saveConfig": {
        const saved = applyClientPatch(msg.patch && typeof msg.patch === "object" ? msg.patch : {});
        log("配置已更新");
        reply({ ok: true, config: clientConfig(saved) });
        return;
      }
      case "providers": {
        reply({ ok: true, providers: scanProviders(msg.workspacePaths) });
        return;
      }
      case "models": {
        const conn = connectionFor(msg);
        let models;
        let source = "catalog";
        try {
          models = await listModels(conn, { timeoutMs: 15000 });
        } catch (error) {
          if (error?.noCatalog && conn.mode === "auto") {
            models = localModels(conn.providerId, msg.workspacePaths);
            source = "local";
            if (!models.length) throw error;
          } else throw error;
        }
        reply({ ok: true, models, source, connection: publicConnection(conn) });
        return;
      }
      case "test": {
        const conn = connectionFor(msg);
        const result = await testConnection(conn, { timeoutMs: 20000 });
        reply({ ok: true, message: result.message, connection: publicConnection(conn) });
        return;
      }
      case "run": {
        const action = actionMeta(msg.action);
        const prompt = renderPrompt(action.id, msg.draft);
        const conn = connectionFor(msg);
        const controller = new AbortController();
        activeRequests.set(id, controller);
        const startedAt = Date.now();
        log(`改写开始 action=${action.id} provider=${conn.providerId} model=${conn.model}`);
        try {
          const text = await callModel(conn, prompt, { signal: controller.signal, timeoutMs: REQUEST_TIMEOUT_MS });
          const elapsed = Date.now() - startedAt;
          pushRun({ at: new Date().toISOString(), action: action.id, provider: conn.providerName, model: conn.model, ms: elapsed, ok: true, chars: text.length });
          log(`改写完成 ${elapsed}ms ${text.length} 字`);
          reply({ ok: true, text, meta: { ...publicConnection(conn), action: action.id, ms: elapsed } });
        } catch (error) {
          const message = safeError(error, [conn.apiKey]);
          pushRun({ at: new Date().toISOString(), action: action.id, provider: conn.providerName, model: conn.model, ms: Date.now() - startedAt, ok: false, error: message });
          log("改写失败:", message);
          reply({ ok: false, error: message });
        } finally {
          activeRequests.delete(id);
        }
        return;
      }
      case "insert": {
        const text = String(msg.text ?? "");
        if (!text || text.length > 100000) throw new Error("无效的回填内容");
        await cdp.insertText(sessionId, text);
        reply({ ok: true });
        return;
      }
      case "cancel": {
        const target = Number(msg.targetId);
        activeRequests.get(target)?.abort();
        reply({ ok: true });
        return;
      }
      case "runs": {
        reply({ ok: true, runs: recentRuns });
        return;
      }
      default:
        reply({ ok: false, error: `未知请求类型：${msg.type}` });
    }
  } catch (error) {
    const message = safeError(error);
    log("请求失败:", message);
    reply({ ok: false, error: message });
  }
}

// ---- CDP 服务 ----
async function serve(wsUrl) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const connection = new CdpConnection(wsUrl, {
      bindingName: BINDING,
      onBinding: (sessionId, payload) => { void handleBinding(sessionId, payload); },
      onLog: log,
    });
    connection.injectSource = injectSource();
    try {
      await connection.connect();
      cdp = connection;
      await connection.attachAll();
      log("CDP 已连接，注入已完成");
      await connection.waitForClose();
      log("CDP 连接断开，2 秒后重连");
    } catch (error) {
      log(`CDP 连接失败（第 ${attempt} 次）：${safeError(error)}`);
    }
    if (attempt >= 5) {
      log("CDP 重试次数用尽，退出");
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function waitForCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const version = await cdpVersion(port, 3000);
    if (version) return version;
    await new Promise((r) => setTimeout(r, 700));
  }
  return null;
}

function launchZcode(port, zcodePath) {
  log(`拉起 ZCode：${zcodePath} --remote-debugging-port=${port}`);
  const child = spawn(zcodePath, [`--remote-debugging-port=${port}`], {
    cwd: path.dirname(zcodePath),
    detached: false,
    stdio: "ignore",
    windowsHide: true,
  });
  child.once("error", (error) => {
    log(`拉起 ZCode 失败：${safeError(error)}`);
    notify(`拉起 ZCode 失败：${safeError(error)}\n\n请检查配置里的 zcodePath：\n${CONFIG_FILE}`);
    process.exit(1);
  });
  child.once("exit", (code) => {
    log(`ZCode 已退出（code=${code}），控制器随之退出`);
    releaseLock();
    process.exit(0);
  });
  return child;
}

// ---- 诊断 ----
async function doctor() {
  const cfg = loadConfig();
  const lines = [];
  lines.push(`ZCode Spark ${VERSION}`);
  lines.push(`node: ${process.version} (${process.execPath})`);
  lines.push(`安装目录: ${INSTALL_DIR}`);
  lines.push(`配置文件: ${CONFIG_FILE}${isFile(CONFIG_FILE) ? "" : "（不存在，将使用默认值）"}`);
  const found = findZcodePath(cfg.zcodePath);
  lines.push(`ZCode: ${found.path ? `${found.path}（来源 ${found.source}）` : `未找到 —— ${found.error}`}`);
  lines.push(`ZCode 是否在运行: ${zcodeProcessesRunning() ? "是" : "否"}`);
  const busy = await cdpVersion(cfg.port, 1200);
  lines.push(`端口 ${cfg.port}: ${busy ? `已有调试端点在响应 ${busy.Browser || ""}` : "空闲"}`);
  lines.push(`连接模式: ${cfg.llm.mode}${cfg.llm.mode === "manual" ? `（${cfg.llm.protocol} / ${cfg.llm.baseUrl || "缺 baseUrl"} / ${cfg.llm.model || "缺模型"}）` : ""}`);
  const providers = scanProviders([]);
  lines.push(`ZCode 供应商: ${providers.length} 个（启用且有 Key: ${providers.filter((p) => p.enabled && p.hasKey).length}）`);
  for (const p of providers.slice(0, 8)) {
    lines.push(`  - ${p.name} [${p.id}] ${p.enabled ? "启用" : "禁用"} ${p.hasKey ? "有Key" : "无Key"} ${p.baseUrl}`);
  }
  try {
    const conn = connectionFor({ modelLabel: "" });
    lines.push(`自动解析: ${conn.providerName} / ${conn.model} / ${conn.protocol} / key=${conn.keySource || "manual"} / ${conn.baseUrl}`);
    lines.push(`端点: ${conn.protocol === "anthropic" ? "/v1/messages" : conn.protocol === "responses" ? "/v1/responses" : "/v1/chat/completions"} 基于 ${conn.baseUrl}`);
  } catch (error) {
    lines.push(`自动解析失败: ${safeError(error)}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
}

// ---- 主流程 ----
async function main() {
  if (hasFlag("--version")) {
    process.stdout.write(`zcode-spark ${VERSION}\n`);
    return;
  }
  if (!IS_WIN) {
    process.stderr.write("ZCode Spark 目前只支持 Windows 桌面版 ZCode。\n");
    process.exit(1);
  }
  ensureConfig();
  if (hasFlag("--doctor")) {
    await doctor();
    return;
  }
  if (hasFlag("--install")) {
    process.stdout.write(`本目录即安装目录：${INSTALL_DIR}\n运行 node install.mjs 可部署到 %LOCALAPPDATA% 并创建桌面快捷方式。\n`);
    return;
  }

  const attach = hasFlag("--attach");
  const cfg = loadConfig();

  if (attach) {
    const port = Number(flagValue("--attach") || cfg.port);
    log(`附着模式：端口 ${port}`);
    const version = await waitForCdp(port, 15000);
    if (!version) {
      process.stderr.write(`端口 ${port} 没有可用的调试端点。请用 --remote-debugging-port=${port} 启动应用后重试。\n`);
      process.exit(1);
    }
    await serve(version.webSocketDebuggerUrl);
    return;
  }

  const owner = acquireLock();
  if (owner !== null) {
    log(`已有控制器在运行（pid=${owner}），激活窗口后退出`);
    activateZcode();
    return;
  }
  process.on("exit", releaseLock);
  process.on("SIGINT", () => { releaseLock(); process.exit(0); });

  const found = findZcodePath(cfg.zcodePath);
  if (!found.path) {
    log(found.error);
    notify(`启动失败：${found.error}\n\n日志：${path.join(INSTALL_DIR, "zcode-spark.log")}`);
    process.exit(1);
  }
  if (found.path !== cfg.zcodePath && found.source !== "env") {
    try { saveConfig({ zcodePath: found.path }); } catch {}
  }
  log(`ZCode 路径：${found.path}（来源 ${found.source}）`);

  // 已经有一个带调试端口的实例在跑 → 直接附着（例如上次控制器异常退出）
  const existing = await cdpVersion(cfg.port, 1500);
  if (existing?.webSocketDebuggerUrl) {
    log(`端口 ${cfg.port} 已有调试端点，直接附着`);
    await serve(existing.webSocketDebuggerUrl);
    return;
  }

  if (zcodeProcessesRunning()) {
    const ok = askYesNo(
      "ZCode 正在运行，Spark 需要以调试端口重启才能注入按钮。\n\n"
      + "关闭并重启 ZCode？请先确认没有未发送的草稿或正在执行的任务。",
    );
    if (!ok) {
      log("用户取消了重启，退出");
      return;
    }
    killZcodeProcesses();
    await new Promise((r) => setTimeout(r, 2500));
  }

  const port = await findFreePort(cfg.port);
  if (port !== cfg.port) log(`端口 ${cfg.port} 被占用，改用 ${port}`);
  launchZcode(port, found.path);
  const version = await waitForCdp(port, CDP_BOOT_TIMEOUT_MS);
  if (!version) {
    log(`等待 CDP 就绪超时（${CDP_BOOT_TIMEOUT_MS / 1000}s）`);
    notify(`ZCode 已启动但调试端口 ${port} 没有就绪。\n\n请查看日志：${path.join(INSTALL_DIR, "zcode-spark.log")}`);
    process.exit(1);
  }
  await serve(version.webSocketDebuggerUrl);
}

// 只有直接运行才启动主流程（被 import 时保持无副作用，测试与诊断脚本可复用模块）
const invokedDirectly = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main().catch((error) => {
    log("控制器异常退出:", safeError(error));
    notify(`ZCode Spark 异常退出：${safeError(error)}`);
    process.exit(1);
  });
}
