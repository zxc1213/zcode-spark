/*
配置与路径。
- 安装目录：默认脚本所在目录；测试或便携场景可用 ZCODE_SPARK_HOME 覆盖
- 配置：zcode-spark-config.json（含手动模式的 apiKey，属本机私密文件，勿提交）
- 日志：zcode-spark.log（超 2MB 自动截断）
*/
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const IS_WIN = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";

export const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const INSTALL_DIR = process.env.ZCODE_SPARK_HOME
  ? path.resolve(process.env.ZCODE_SPARK_HOME)
  : SOURCE_ROOT;
export const ZCODE_HOME = path.join(os.homedir(), ".zcode");
export const CONFIG_FILE = path.join(INSTALL_DIR, "zcode-spark-config.json");
export const LOG_FILE = path.join(INSTALL_DIR, "zcode-spark.log");

export function configPath() {
  return CONFIG_FILE;
}
export function logPath() {
  return LOG_FILE;
}

const DEFAULTS = {
  zcodePath: "",
  port: 9337,
  hotkey: "Ctrl+Shift+E",
  hotkeyEnabled: true,
  defaultAction: "enhance",
  llm: {
    mode: "auto",
    providerId: "",
    model: "",
    baseUrl: "",
    protocol: "anthropic",
    apiKey: "",
    allowLocal: true,
  },
};

const README = [
  "ZCode Spark 配置。",
  "zcodePath：ZCode.exe 完整路径，留空自动探测；也支持环境变量 ZCODE_SPARK_ZCODE_PATH（优先级最高）。",
  "port：调试端口，默认 9337，被占用时自动顺延 9338-9360。",
  "llm.mode=auto：复用 ZCode 已配置的供应商与凭据（~/.zcode/v2/config.json），providerId/model 留空表示跟随输入框当前模型。",
  "llm.mode=manual：使用下面的 baseUrl/apiKey/model/protocol（protocol: anthropic | chat | responses）。",
  "llm.allowLocal：允许请求 127.0.0.1 等本机/内网地址（本机代理场景需要，默认开启）。",
  "apiKey 只存在本机这个文件里，不会返回给页面、不会写进日志。",
];

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function merge(base, patch) {
  if (!patch || typeof patch !== "object") return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)
      && base && typeof base[key] === "object" && !Array.isArray(base[key])) {
      out[key] = merge(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function normalize(cfg) {
  const out = merge(DEFAULTS, cfg || {});
  out.port = Number.isFinite(+out.port) ? Math.min(65535, Math.max(1024, Math.trunc(+out.port))) : DEFAULTS.port;
  out.hotkey = typeof out.hotkey === "string" && out.hotkey.trim() ? out.hotkey.trim() : DEFAULTS.hotkey;
  out.hotkeyEnabled = out.hotkeyEnabled !== false;
  out.defaultAction = ["enhance", "concise", "structure", "english", "proofread"].includes(out.defaultAction)
    ? out.defaultAction : DEFAULTS.defaultAction;
  out.zcodePath = typeof out.zcodePath === "string" ? out.zcodePath.trim() : "";
  out.llm = merge(DEFAULTS.llm, out.llm || {});
  out.llm.mode = out.llm.mode === "manual" ? "manual" : "auto";
  out.llm.protocol = ["anthropic", "chat", "responses"].includes(out.llm.protocol) ? out.llm.protocol : "anthropic";
  out.llm.allowLocal = out.llm.allowLocal !== false;
  for (const key of ["providerId", "model", "baseUrl", "apiKey"]) {
    out.llm[key] = typeof out.llm[key] === "string" ? out.llm[key].trim() : "";
  }
  return out;
}

export function loadConfig() {
  const raw = readJson(configPath());
  return normalize(raw);
}

export function defaultConfig(extra = {}) {
  return { _readme: README, ...normalize(extra) };
}

export function ensureConfig() {
  if (fs.existsSync(configPath())) return loadConfig();
  const cfg = normalize({ _readme: README });
  try {
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify({ _readme: README, ...cfg }, null, 2) + "\n", "utf8");
  } catch {}
  return cfg;
}

export function saveConfig(patch) {
  const current = loadConfig();
  const next = normalize(merge(current, patch || {}));
  const out = { _readme: README, ...next };
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  const tmp = configPath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, configPath());
  return next;
}

// 页面只能改这几个字段；apiKey 只进不出：空串表示保持，clearApiKey 才清空
export function applyClientPatch(patch = {}) {
  const allowed = {};
  for (const key of ["defaultAction", "hotkey", "hotkeyEnabled", "zcodePath"]) {
    if (patch[key] !== undefined) allowed[key] = patch[key];
  }
  if (patch.llm && typeof patch.llm === "object") {
    const llm = {};
    for (const key of ["mode", "providerId", "model", "baseUrl", "protocol", "allowLocal"]) {
      if (patch.llm[key] !== undefined) llm[key] = patch.llm[key];
    }
    if (typeof patch.llm.apiKey === "string" && patch.llm.apiKey.trim()) llm.apiKey = patch.llm.apiKey.trim();
    if (patch.llm.clearApiKey === true) llm.apiKey = "";
    allowed.llm = llm;
  }
  return saveConfig(allowed);
}

// 发给页面的视图：不含 apiKey，只告知是否已保存
export function clientConfig(cfg) {
  const { apiKey, ...rest } = cfg.llm;
  return {
    ...cfg,
    llm: { ...rest, apiKeySet: Boolean(apiKey) },
  };
}

let logFile = null;
export function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => (typeof p === "string" ? p : safeError(p))).join(" ")}`;
  try {
    process.stdout.write(line + "\n");
  } catch {}
  try {
    if (!logFile) logFile = logPath();
    try {
      if (fs.statSync(logFile).size > 2 * 1024 * 1024) fs.truncateSync(logFile, 0);
    } catch {}
    fs.appendFileSync(logFile, line + "\n", "utf8");
  } catch {}
}

export function safeError(error, secrets = []) {
  let text = String(error?.message || error || "未知错误");
  for (const secret of secrets) {
    if (secret && String(secret).length > 3) text = text.split(String(secret)).join("[redacted]");
  }
  return text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/x-api-key["':\s]+\S+/gi, "x-api-key [redacted]").slice(0, 500);
}
