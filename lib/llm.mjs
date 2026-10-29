/*
模型调用：三种协议适配（anthropic / chat / responses），非流式。
- 只取正文，丢弃 reasoning/thinking 段落
- 错误信息脱敏（不含 Key、不含草稿正文）
*/
import { joinEndpoint } from "./providers.mjs";

const JSON_HEADERS = { "content-type": "application/json" };
const DEFAULT_TIMEOUT_MS = 90000;

function endpointFor(baseUrl, protocol) {
  if (protocol === "anthropic") return joinEndpoint(baseUrl, "/messages");
  if (protocol === "responses") return joinEndpoint(baseUrl, "/responses");
  return joinEndpoint(baseUrl, "/chat/completions");
}

function headersFor(cfg) {
  const headers = { ...JSON_HEADERS, ...(cfg.headers || {}) };
  if (cfg.protocol === "anthropic") {
    headers["x-api-key"] = cfg.apiKey;
    headers["authorization"] = `Bearer ${cfg.apiKey}`;
    headers["anthropic-version"] = headers["anthropic-version"] || "2023-06-01";
  } else {
    headers["authorization"] = `Bearer ${cfg.apiKey}`;
  }
  return headers;
}

function bodyFor(cfg, prompt, maxTokens) {
  if (cfg.protocol === "anthropic") {
    return {
      model: cfg.model,
      max_tokens: maxTokens,
      temperature: 0.3,
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
    };
  }
  if (cfg.protocol === "responses") {
    return {
      model: cfg.model,
      temperature: 0.3,
      input: [
        { role: "system", content: [{ type: "input_text", text: prompt.system }] },
        { role: "user", content: [{ type: "input_text", text: prompt.user }] },
      ],
    };
  }
  return {
    model: cfg.model,
    temperature: 0.3,
    stream: false,
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
  };
}

function joinText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => (typeof part === "string" ? part : part?.text || "")).join("");
  }
  return "";
}

export function extractText(data, protocol) {
  if (!data || typeof data !== "object") return "";
  if (protocol === "anthropic") {
    return (Array.isArray(data.content) ? data.content : [])
      .filter((block) => block && (block.type === "text" || typeof block.text === "string"))
      .map((block) => joinText(block.text))
      .join("");
  }
  if (protocol === "responses") {
    if (typeof data.output_text === "string") return data.output_text;
    return (Array.isArray(data.output) ? data.output : [])
      .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
      .map((part) => joinText(part?.text))
      .join("");
  }
  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  return joinText(choice?.message?.content) || joinText(choice?.text);
}

export function stripThinking(raw) {
  let text = String(raw ?? "");
  text = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "");
  text = text.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "");
  text = text.replace(/<\/?(?:thinking|reasoning|analysis)>/gi, "");
  text = text.replace(/^\s*(?:以下是|这是|下面是).{0,30}?(?:提示词|prompt|结果)[^\n]{0,10}[:：]\s*/i, "");
  text = text.trim();
  // 整段被一层 markdown 围栏包住时拆掉（仅限无语言标记或 markdown/text/prompt 标记）
  const fence = text.match(/^```(markdown|md|text|prompt|plaintext)?\n([\s\S]*?)\n```$/i);
  if (fence && !(fence[2] || "").includes("```")) text = fence[2].trim();
  return text;
}

function extractError(data) {
  const err = data?.error;
  if (!err) return "";
  if (typeof err === "string") return err;
  return String(err.message || err.msg || err.code || "");
}

export class LlmError extends Error {
  constructor(message, { status = 0, noCatalog = false } = {}) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.noCatalog = noCatalog;
  }
}

function explainStatus(status, detail) {
  const tail = detail ? `：${detail}` : "";
  if (status === 401 || status === 403) {
    return new LlmError(
      `鉴权失败（HTTP ${status}）${tail}。ZCode 里保存的 Key 可能只能由它自己的网关使用；`
      + "请改用手动连接，填大模型开放平台的普通 API Key", { status },
    );
  }
  if (status === 404) {
    return new LlmError(`接口不存在（HTTP 404）${tail}。请确认 Base URL 与协议（anthropic / chat / responses）是否匹配`, { status, noCatalog: true });
  }
  if (status === 429) return new LlmError(`请求过于频繁或额度用尽（HTTP 429）${tail}`, { status });
  if (status >= 500) return new LlmError(`服务端错误（HTTP ${status}）${tail}`, { status });
  return new LlmError(`请求失败（HTTP ${status}）${tail}`, { status });
}

async function requestJson(url, options, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.any(signals) });
  } catch (error) {
    if (signal?.aborted) throw new LlmError("已取消");
    if (error?.name === "TimeoutError") throw new LlmError(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw new LlmError(`无法连接模型服务：${error?.message || error}`);
  }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!response.ok) throw explainStatus(response.status, extractError(data));
  return data;
}

export async function callModel(cfg, prompt, { signal, timeoutMs, maxTokens = 4096 } = {}) {
  const url = endpointFor(cfg.baseUrl, cfg.protocol);
  const data = await requestJson(url, {
    method: "POST",
    headers: headersFor(cfg),
    body: JSON.stringify(bodyFor(cfg, prompt, maxTokens)),
  }, { signal, timeoutMs });

  const text = stripThinking(extractText(data, cfg.protocol));
  if (!text) {
    const detail = extractError(data) || (data?.stop_reason ? `stop_reason=${data.stop_reason}` : "响应为空");
    throw new LlmError(`模型没有返回可用内容（${detail}）`);
  }
  return text;
}

export async function listModels(cfg, { signal, timeoutMs = 15000 } = {}) {
  const url = joinEndpoint(cfg.baseUrl, "/models");
  const data = await requestJson(url, { method: "GET", headers: headersFor(cfg) }, { signal, timeoutMs });
  const items = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  const ids = items
    .map((item) => (typeof item === "string" ? item : String(item?.id || item?.model || item?.name || "").trim()))
    .filter(Boolean);
  if (!ids.length) throw new LlmError("该服务没有返回模型列表", { noCatalog: true });
  return [...new Set(ids)].sort();
}

// 诊断用：只验证连通与鉴权，不消耗生成额度（优先 /models，失败后允许仍视为连通）
export async function testConnection(cfg, opts = {}) {
  try {
    const models = await listModels(cfg, opts);
    return { ok: true, message: `连接成功，目录 ${models.length} 个模型${models.includes(cfg.model) ? `，包含 ${cfg.model}` : `，未列出 ${cfg.model}`}` };
  } catch (error) {
    if (error?.noCatalog && error?.status !== 401 && error?.status !== 403) {
      return { ok: true, message: `服务已响应（HTTP 可达，未提供模型目录）；请确认模型名 ${cfg.model} 后保存` };
    }
    throw error;
  }
}
