/*
供应商解析：复用 ZCode 自己的模型配置（~/.zcode/v2/config.json 与工作区级同名文件）。
思路：页面把输入框当前模型标签（形如 "供应商/模型"）传上来，能对上就直接用那家；
对不上再按配置里启用的供应商兜底。凭据只在本进程内存中使用。
*/
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ZCODE_HOME, readJson } from "./config.mjs";

const BLOCKED_HOSTS = new Set([
  "0.0.0.0", "[::]", "::", "169.254.169.254", "metadata.google.internal", "metadata",
]);

// 只允许 http/https；拒绝链路本地与云元数据地址。本机/内网回环在 allowLocal 下放行
// （ZCode 的本机代理供应商与本机 mock 测试都依赖它）。
export function normalizeBase(value, { allowLocal = true } = {}) {
  let url;
  try { url = new URL(String(value || "").trim()); }
  catch { throw new Error("Base URL 不是有效的绝对地址（需以 http:// 或 https:// 开头）"); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("Base URL 仅支持 http/https");
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) throw new Error(`Base URL 指向被拒绝的地址：${host}`);
  if (/^(169\.254\.|fe80:|fec0:)/i.test(host)) throw new Error(`Base URL 指向链路本地地址：${host}`);
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1"
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (local && !allowLocal) throw new Error(`配置禁止访问本机/内网地址：${host}（llm.allowLocal）`);
  return String(value).trim().replace(/\/+$/, "");
}

// baseURL 多已含版本段（/v1、/v4、/api/v1），两种形状都要兼容，避免 /v1/v1
export function joinEndpoint(base, endpoint) {
  return /\/v\d+$/.test(base) ? `${base}${endpoint}` : `${base}/v1${endpoint}`;
}

export function protocolOf(provider) {
  const kind = String(provider?.kind || "").toLowerCase();
  if (kind === "anthropic") return "anthropic";
  if (kind.includes("responses")) return "responses";
  return "chat";
}

function providerKey(provider) {
  return String(provider?.options?.apiKey || "").trim();
}

// 合并用户级 + 工作区级供应商池（工作区级优先，同一 id 先到先得）
export function collectPools(workspacePaths = []) {
  const files = [];
  const seen = new Set();
  const add = (dir, tag) => {
    if (!dir) return;
    let cur = path.resolve(String(dir));
    for (let depth = 0; depth < 3 && cur; depth++) {
      const file = path.join(cur, ".zcode", "v2", "config.json");
      if (fs.existsSync(file) && !seen.has(file)) { seen.add(file); files.push({ file, tag }); }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  };
  for (const ws of Array.isArray(workspacePaths) ? workspacePaths : []) add(ws, "workspace");
  add(ZCODE_HOME, "user");

  const pools = [];
  for (const { file, tag } of files) {
    const cfg = readJson(file);
    if (cfg?.provider && typeof cfg.provider === "object") {
      pools.push({ file, tag, providers: cfg.provider });
    }
  }
  return pools;
}

export function scanProviders(workspacePaths = []) {
  const pools = collectPools(workspacePaths);
  const out = [];
  const seen = new Set();
  for (const pool of pools) {
    for (const [id, provider] of Object.entries(pool.providers)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const baseUrl = String(provider?.options?.baseURL || "").trim();
      out.push({
        id,
        name: String(provider?.name || id),
        enabled: provider?.enabled !== false,
        protocol: protocolOf(provider),
        baseUrl,
        hasKey: Boolean(providerKey(provider)),
        models: Object.keys(provider?.models || {}),
        source: pool.tag,
      });
    }
  }
  return out;
}

export function localModels(providerId, workspacePaths = []) {
  for (const pool of collectPools(workspacePaths)) {
    const provider = pool.providers?.[providerId];
    if (provider && provider.enabled !== false) {
      const ids = Object.keys(provider.models || {});
      if (ids.length) return ids.sort();
    }
  }
  return [];
}

function resolveKey(provider) {
  const direct = providerKey(provider);
  if (direct) return { apiKey: direct, keySource: "provider" };
  // 供应商未存 key 时，尝试 ZCode 凭据库里的 OAuth access token（仅内存）
  const cred = readJson(path.join(ZCODE_HOME, "v2", "credentials.json")) || {};
  const active = cred["oauth:active_provider"];
  const tokens = Object.entries(cred).filter(([k, v]) => k.startsWith("oauth:") && k.endsWith(":access_token") && typeof v === "string" && v.length > 8);
  const chosen = (active && tokens.find(([k]) => k.startsWith(`oauth:${active}:`))) || tokens[0];
  return chosen ? { apiKey: chosen[1], keySource: "credentials" } : { apiKey: "", keySource: "none" };
}

function labelScore(modelId, label) {
  if (!label) return 0;
  const a = modelId.toLowerCase(), b = label.toLowerCase();
  if (a === b) return 3;
  if (a.endsWith("/" + b) || b.endsWith("/" + a)) return 2;
  if (a.includes(b) || b.includes(a)) return 1;
  return 0;
}

/**
 * 解析自动模式连接参数。
 * @param {{providerId?:string, model?:string, modelLabel?:string, workspacePaths?:string[], allowLocal?:boolean}} want
 */
export function resolveAuto(want = {}) {
  const pools = collectPools(want.workspacePaths || []);
  if (!pools.length) throw new Error("读不到 ZCode 模型配置（~/.zcode/v2/config.json），请改用「手动连接」");

  // 工作区级优先合并进一张表：id -> provider
  const ids = new Map();
  for (const pool of pools) {
    for (const [id, provider] of Object.entries(pool.providers)) {
      if (!ids.has(id)) ids.set(id, { id, provider, source: pool.tag });
    }
  }
  const entries = [...ids.values()].filter((e) => e.provider?.enabled !== false);
  if (!entries.length) throw new Error("ZCode 中没有已启用的供应商，请改用「手动连接」");

  const label = String(want.modelLabel || "").trim();
  const parts = label.split("/");
  const namePart = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
  const modelPart = parts.length > 1 ? parts[parts.length - 1] : label;

  let picked = null;
  let model = "";

  // 1) 设置里明确指定的供应商
  if (want.providerId) {
    picked = entries.find((e) => e.id === want.providerId);
    if (!picked) throw new Error(`设置的供应商不存在或已禁用：${want.providerId}`);
    model = want.model || "";
  }

  // 2) 输入框模型标签匹配（供应商名 + 模型名两段）
  if (!picked && label) {
    for (const entry of entries) {
      const name = String(entry.provider?.name || entry.id);
      const nameHit = name === label || (namePart && (name === namePart || name.includes(namePart) || namePart.includes(name)));
      if (!nameHit) continue;
      const models = Object.keys(entry.provider.models || {});
      const hit = models.find((id) => id === modelPart)
        || models.find((id) => id.endsWith("/" + modelPart) || modelPart.endsWith("/" + id))
        || models.find((id) => labelScore(id, modelPart) > 0);
      picked = entry;
      model = hit || models[0] || "";
      break;
    }
  }
  if (!picked && modelPart) {
    for (const entry of entries) {
      const hit = Object.keys(entry.provider.models || {}).find((id) => labelScore(id, modelPart) >= 2);
      if (hit) { picked = entry; model = hit; break; }
    }
  }

  // 3) 兜底：自带 key 的启用供应商，取第一个模型
  if (!picked) {
    const scored = [...entries].sort((a, b) => {
      const score = (e) => (providerKey(e.provider) ? 2 : 0) + (e.provider?.options?.baseURL ? 1 : 0);
      return score(b) - score(a);
    });
    picked = scored.find((e) => Object.keys(e.provider.models || {}).length) || scored[0];
  }

  const models = Object.keys(picked.provider.models || {});
  if (!model) model = want.model || models[0] || "";
  if (!model) throw new Error(`供应商 ${picked.id} 未配置任何模型，请改用「手动连接」`);

  const baseUrl = normalizeBase(picked.provider?.options?.baseURL || "", { allowLocal: want.allowLocal !== false });
  if (!baseUrl) throw new Error(`供应商 ${picked.id} 没有 baseURL，请改用「手动连接」`);

  const { apiKey, keySource } = resolveKey(picked.provider);
  if (!apiKey) throw new Error(`供应商 ${picked.id} 没有可用凭据（可能未登录），请改用「手动连接」`);

  return {
    mode: "auto",
    providerId: picked.id,
    providerName: String(picked.provider?.name || picked.id),
    baseUrl,
    apiKey,
    model,
    protocol: protocolOf(picked.provider),
    keySource,
    headers: picked.provider?.options?.headers || {},
    source: picked.source,
  };
}
