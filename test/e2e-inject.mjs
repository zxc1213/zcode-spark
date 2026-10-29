/*
端到端注入测试（不需要启动真正的 ZCode）：
- 用 Edge 无头模式打开 test/mock-composer.html（复刻 ZCode 的 composer testid 结构）
- 起一个假的 Anthropic 兼容服务，断言控制器确实把模板发给了模型
- 控制器以 --attach 附着到 Edge 的调试端口，走真实的 CDP 注入链路
- 断言：按钮注入 → 菜单 → 改写 → 回填 → 撤销 → 快捷键 → 设置面板
用法：node test/e2e-inject.mjs [--headful]
*/
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEADFUL = process.argv.includes("--headful");
const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => fs.existsSync(p));

if (!EDGE) {
  process.stdout.write("跳过 e2e：本机没有 Edge，无法做真实 Chromium 注入测试\n");
  process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "zspark-e2e-"));
const installDir = path.join(sandbox, "install");
const profileDir = path.join(sandbox, "profile");
fs.mkdirSync(installDir, { recursive: true });
fs.copyFileSync(path.join(ROOT, "inject.js"), path.join(installDir, "inject.js"));

const results = [];
let controllerLog = "";
function check(name, fn) {
  return (async () => {
    await fn();
    results.push({ name, ok: true });
    process.stdout.write(`  ok   ${name}\n`);
  })();
}

async function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// ---- 假的模型服务 ----
const calls = [];
const llm = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    if (req.method === "GET" && req.url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "demo-small" }, { id: "demo-large" }] }));
      return;
    }
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    calls.push({ url: req.url, headers: req.headers, body: parsed });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      content: [
        { type: "thinking", thinking: "（测试用推理，应被丢弃）" },
        { type: "text", text: `改写结果 MOCK_OK\n第二行保留\n\nconst a = 1;` },
      ],
    }));
  });
});

// ---- 简易 CDP 客户端（浏览器级，flatten session）----
class Client {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.exceptions = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener("open", resolve);
      this.ws.addEventListener("error", () => reject(new Error("CDP 连接失败")));
      this.ws.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && this.pending.has(msg.id)) {
          const entry = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(msg.error.message));
          else entry.resolve(msg.result);
        } else if (msg.method === "Runtime.exceptionThrown") {
          this.exceptions.push(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || "unknown");
        }
      });
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }
  async attach(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    this.sessionId = sessionId;
    await this.send("Runtime.enable", {}, sessionId);
    return sessionId;
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, this.sessionId);
    if (result.exceptionDetails) {
      throw new Error(`页面执行出错：${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    }
    return result.result?.value;
  }
  async waitFor(expression, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(expression)) return true;
      } catch {}
      await sleep(150);
    }
    throw new Error(`等待超时：${label}（${expression}）`);
  }
  close() { try { this.ws?.close(); } catch {} }
}

async function waitJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return await response.json();
    } catch {}
    await sleep(200);
  }
  return null;
}

const cleanup = [];
async function teardown() {
  for (const fn of cleanup.reverse()) {
    try { await fn(); } catch {}
  }
}

async function main() {
  await new Promise((resolve) => llm.listen(0, "127.0.0.1", resolve));
  const llmPort = llm.address().port;
  cleanup.push(() => new Promise((resolve) => llm.close(resolve)));

  const config = {
    zcodePath: "",
    port: 9401,
    hotkey: "Ctrl+Shift+E",
    hotkeyEnabled: true,
    defaultAction: "enhance",
    llm: {
      mode: "manual",
      providerId: "",
      model: "demo-small",
      baseUrl: `http://127.0.0.1:${llmPort}/api/anthropic`,
      protocol: "anthropic",
      apiKey: "test-key-do-not-log",
      allowLocal: true,
    },
  };
  fs.writeFileSync(path.join(installDir, "zcode-spark-config.json"), JSON.stringify(config, null, 2), "utf8");

  const debugPort = await freePort();
  const pageUrl = new URL(`file:///${path.join(ROOT, "test", "mock-composer.html").replace(/\\/g, "/")}`).href;
  const edge = spawn(EDGE, [
    ...(HEADFUL ? [] : ["--headless=new"]),
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-gpu",
    pageUrl,
  ], { stdio: "ignore" });
  cleanup.push(() => {
    spawnSync("taskkill.exe", ["/PID", String(edge.pid), "/T", "/F"], { windowsHide: true });
  });

  const targets = await waitJson(`http://127.0.0.1:${debugPort}/json/list`, 20000);
  assert.ok(targets, "Edge 调试端口未就绪");
  const page = targets.find((t) => t.type === "page" && t.url.includes("mock-composer"));
  assert.ok(page, `找不到测试页面，targets=${JSON.stringify(targets.map((t) => [t.type, t.url]))}`);

  const version = await waitJson(`http://127.0.0.1:${debugPort}/json/version`, 10000);
  const client = new Client(version.webSocketDebuggerUrl);
  await client.connect();
  await client.attach(page.id);
  cleanup.push(() => client.close());

  // 预置草稿（直接写 DOM：模拟用户输入）
  await client.evaluate(`(() => {
    const input = document.querySelector('[data-testid="v4-composer-input"]');
    input.focus();
    document.execCommand('insertText', false, '帮我把登录页改好看一点，顺便加个记住密码');
    return input.innerText;
  })()`);

  const controller = spawn(process.execPath, [path.join(ROOT, "controller.mjs"), "--attach", String(debugPort)], {
    cwd: ROOT,
    env: { ...process.env, ZCODE_SPARK_HOME: installDir },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let controllerLogLocal = "";
  controller.stdout.on("data", (chunk) => { controllerLog += chunk.toString(); controllerLogLocal += chunk.toString(); });
  controller.stderr.on("data", (chunk) => { controllerLog += chunk.toString(); controllerLogLocal += chunk.toString(); });
  cleanup.push(() => new Promise((resolve) => {
    controller.once("exit", resolve);
    try { controller.kill(); } catch { resolve(); }
    setTimeout(resolve, 4000);
  }));

  process.stdout.write("e2e（Edge + 真实 CDP 注入）\n");

  await check("控制器附着并注入按钮", async () => {
    try {
      await client.waitFor(`!!document.getElementById('zspark-btn')`, 20000, "按钮未出现");
    } catch (error) {
      const diagnose = await client.evaluate(`JSON.stringify({
        runtime: window.__zcodeSparkRuntime || null,
        binding: typeof window.__zcodeSpark,
        composer: !!document.querySelector('[data-testid="v4-composer"]'),
        style: !!document.getElementById('zspark-style'),
      })`).catch((err) => String(err));
      throw new Error(`${error.message}\n       诊断=${diagnose}\n       控制器日志=${controllerLogLocal.slice(-1200)}`);
    }
  });

  await check("按钮挂在 composer 行内、位于模式切换之后", async () => {
    const info = await client.evaluate(`(() => {
      const button = document.getElementById('zspark-btn');
      const anchor = document.querySelector('[data-testid="chat-mode-select-trigger"]');
      return {
        next: button?.parentElement?.previousElementSibling === anchor,
        visible: button.getBoundingClientRect().width > 0,
      };
    })()`);
    assert.equal(info.visible, true, "按钮不可见");
    assert.equal(info.next, true, "按钮未紧跟模式切换控件");
  });

  await check("点击打开菜单，含 5 个动作与设置", async () => {
    await client.evaluate(`document.getElementById('zspark-btn').click()`);
    await client.waitFor(`!!document.getElementById('zspark-menu')`, 3000, "菜单未打开");
    const labels = await client.evaluate(`[...document.querySelectorAll('#zspark-menu .zspark-label')].map(n => n.textContent)`);
    assert.deepEqual(labels, ["增强", "精简", "结构化", "中译英", "纠错", "设置"]);
  });

  await check("点「增强」→ 模型被调用且提示词模板正确", async () => {
    await client.evaluate(`document.querySelector('#zspark-menu .zspark-item[data-action="enhance"]').click()`);
    await client.waitFor(`document.querySelector('[data-testid="v4-composer-input"]').innerText.includes('MOCK_OK')`, 20000, "结果未回填");
    assert.equal(calls.length, 1, `模型应被调用 1 次，实际 ${calls.length}`);
    const call = calls[0];
    assert.ok(call.url.includes("/v1/messages"), `端点不对：${call.url}`);
    assert.ok(String(call.headers["x-api-key"]).startsWith("test-key"), "缺少 x-api-key");
    assert.ok(call.body.system.includes("提示词工程师"), "system 模板不对");
    assert.ok(call.body.messages[0].content.includes("登录页"), "草稿未进入 user 消息");
    assert.equal(call.body.model, "demo-small");
  });

  await check("回填结果干净（thinking 被丢弃、代码块保留）", async () => {
    const text = await client.evaluate(`document.querySelector('[data-testid="v4-composer-input"]').innerText`);
    assert.ok(text.includes("改写结果 MOCK_OK"));
    assert.ok(text.includes("const a = 1;"));
    assert.ok(!text.includes("测试用推理"), "thinking 内容漏进了输入框");
  });

  await check("撤销按钮出现并能恢复原文", async () => {
    // 文字先进 DOM，页面随后才收到控制器回执；等运行时收敛再断言
    try {
      await client.waitFor(`(window.__zcodeSparkDebug?.().history || 0) >= 1 && window.__zcodeSparkDebug().busyId === 0`, 10000, "改写流程未收敛");
    } catch (error) {
      const debug = await client.evaluate(`JSON.stringify(window.__zcodeSparkDebug?.() || {})`).catch((err) => String(err));
      throw new Error(`${error.message}；运行状态=${debug}`);
    }
    const debug = await client.evaluate(`JSON.stringify(window.__zcodeSparkDebug?.() || {})`);
    const visible = await client.evaluate(`!document.getElementById('zspark-undo').hidden`);
    assert.equal(visible, true, `撤销按钮未显示；运行状态=${debug}`);
    await client.evaluate(`document.getElementById('zspark-undo').click()`);
    await client.waitFor(`document.querySelector('[data-testid="v4-composer-input"]').innerText.includes('登录页改好看')`, 10000, "撤销未生效");
    const hidden = await client.evaluate(`document.getElementById('zspark-undo').hidden`);
    assert.equal(hidden, true, "撤销栈应清空");
  });

  await check("快捷键 Ctrl+Shift+E 触发默认动作", async () => {
    const before = calls.length;
    await client.evaluate(`(() => {
      const input = document.querySelector('[data-testid="v4-composer-input"]');
      input.focus();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true, bubbles: true }));
    })()`);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && calls.length <= before) await sleep(150);
    assert.ok(calls.length > before, "快捷键没有发起请求");
  });

  await check("右键/菜单进入设置面板并读到配置", async () => {
    await client.evaluate(`document.getElementById('zspark-btn').click()`);
    await client.waitFor(`!!document.getElementById('zspark-menu')`, 3000, "菜单未打开");
    await client.evaluate(`document.querySelectorAll('#zspark-menu .zspark-item')[5].click()`);
    await client.waitFor(`!!document.getElementById('zspark-panel')`, 3000, "设置面板未打开");
    await client.waitFor(`(document.getElementById('zspark-panel')?.innerText || '').includes('连接')`, 5000, "设置面板未渲染完成");
    const text = await client.evaluate(`document.getElementById('zspark-panel').innerText`);
    assert.ok(text.includes("连接"));
    assert.ok(text.includes("手动连接"));
    assert.ok(!text.includes("test-key-do-not-log"), "API Key 不应回显到页面");
    await client.evaluate(`document.querySelector('#zspark-panel [data-role="close"]').click()`);
    await client.waitFor(`!document.getElementById('zspark-panel')`, 3000, "设置面板未关闭");
  });

  await check("页面无未捕获异常", async () => {
    assert.deepEqual(client.exceptions, []);
  });
}

try {
  await main();
  process.stdout.write(`\n${results.length} passed\n`);
  await teardown();
  await sleep(500);
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); break; }
    catch { await sleep(600); }
  }
  process.exit(0);
} catch (error) {
  process.stdout.write(`\n失败：${error.message}\n`);
  if (error.stack) process.stdout.write(error.stack.split("\n").slice(1, 4).join("\n") + "\n");
  if (controllerLog) process.stdout.write(`\n--- 控制器日志 ---\n${controllerLog.slice(-2000)}\n`);
  await teardown();
  process.exit(1);
}
