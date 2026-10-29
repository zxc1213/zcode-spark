/*
单元测试：零依赖，node test/unit.mjs
覆盖模板渲染、正文提取、thinking 清理、端点拼接、地址校验、配置读写、供应商解析。
*/
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "zspark-unit-"));
// 在导入模块前改掉用户目录与安装目录：config/providers 在模块加载时读取它们
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
process.env.ZCODE_SPARK_HOME = path.join(sandbox, "install");
fs.mkdirSync(path.join(sandbox, ".zcode", "v2"), { recursive: true });
fs.writeFileSync(path.join(sandbox, ".zcode", "v2", "config.json"), JSON.stringify({
  provider: {
    demo: {
      name: "DemoProvider",
      kind: "anthropic",
      enabled: true,
      options: { apiKey: "k-demo-1234", baseURL: "https://api.example.com/anthropic" },
      models: { "demo-large": {}, "demo-small": {} },
    },
    disabled: { name: "Off", kind: "openai", enabled: false, options: {}, models: { x: {} } },
  },
}), "utf8");

const { ACTIONS, actionMeta, renderPrompt } = await import("../lib/prompts.mjs");
const { extractText, stripThinking } = await import("../lib/llm.mjs");
const { joinEndpoint, normalizeBase, scanProviders, resolveAuto, localModels } = await import("../lib/providers.mjs");
const { loadConfig, saveConfig, clientConfig, defaultConfig, applyClientPatch } = await import("../lib/config.mjs");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    failed++;
    process.stdout.write(`  FAIL ${name}\n       ${error.message}\n`);
  }
}

process.stdout.write("prompts\n");
test("五个动作齐全", () => {
  assert.deepEqual(ACTIONS.map((a) => a.id), ["enhance", "concise", "structure", "english", "proofread"]);
});
for (const action of ACTIONS) {
  test(`${action.id} 渲染包含草稿与输出纪律`, () => {
    const prompt = renderPrompt(action.id, "  把这段代码重构一下\n第二行  ");
    assert.ok(prompt.user.includes("把这段代码重构一下"));
    assert.ok(prompt.system.includes("输出纪律"));
    assert.ok(!prompt.user.includes("{input}"));
    assert.equal(prompt.action, action.id);
  });
}
test("空草稿与超长草稿报错", () => {
  assert.throws(() => renderPrompt("enhance", "   "), /草稿为空/);
  assert.throws(() => renderPrompt("enhance", "x".repeat(100001)), /草稿过长/);
});
test("未知动作回退增强", () => {
  assert.equal(actionMeta("nope").id, "enhance");
});

process.stdout.write("llm\n");
test("anthropic 只取 text 块", () => {
  const data = { content: [{ type: "thinking", thinking: "内部推理" }, { type: "text", text: "结果" }] };
  assert.equal(extractText(data, "anthropic"), "结果");
});
test("chat 取 message.content（忽略 reasoning_content）", () => {
  const data = { choices: [{ message: { content: "答案", reasoning_content: "推理" } }] };
  assert.equal(extractText(data, "chat"), "答案");
});
test("chat 内容为分段数组时拼接", () => {
  const data = { choices: [{ message: { content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] } }] };
  assert.equal(extractText(data, "chat"), "AB");
});
test("responses 优先 output_text，其次 output 数组", () => {
  assert.equal(extractText({ output_text: "直接" }, "responses"), "直接");
  assert.equal(extractText({ output: [{ content: [{ type: "output_text", text: "拼" }, { type: "output_text", text: "接" }] }] }, "responses"), "拼接");
});
test("stripThinking 去掉思考块", () => {
  assert.equal(stripThinking("<thinking>想很久</thinking>正式内容"), "正式内容");
  assert.equal(stripThinking("正文<thinking>尾注</thinking>"), "正文");
});
test("stripThinking 拆掉整体代码围栏", () => {
  assert.equal(stripThinking("```markdown\n真正的提示词\n```"), "真正的提示词");
});
test("stripThinking 去掉‘以下是…提示词：’引导语", () => {
  assert.equal(stripThinking("以下是增强后的提示词：\n内容"), "内容");
});

process.stdout.write("endpoints\n");
test("joinEndpoint 兼容已带版本段的 base", () => {
  assert.equal(joinEndpoint("https://a.com/v1", "/messages"), "https://a.com/v1/messages");
  assert.equal(joinEndpoint("https://a.com/api/anthropic", "/messages"), "https://a.com/api/anthropic/v1/messages");
  assert.equal(joinEndpoint("https://a.com/api/paas/v4", "/chat/completions"), "https://a.com/api/paas/v4/chat/completions");
});
test("normalizeBase 拒绝非 http(s)", () => {
  assert.throws(() => normalizeBase("file:///etc/passwd"), /仅支持 http\/https/);
  assert.throws(() => normalizeBase("ftp://a.com"), /仅支持 http\/https/);
  assert.throws(() => normalizeBase("不是地址"), /有效的绝对地址/);
});
test("normalizeBase 拒绝链路本地与云元数据地址", () => {
  assert.throws(() => normalizeBase("http://169.254.169.254/latest"), /被拒绝|链路本地/);
  assert.throws(() => normalizeBase("http://0.0.0.0/"), /被拒绝/);
});
test("normalizeBase 允许本机地址，allowLocal=false 时拒绝", () => {
  assert.equal(normalizeBase("http://127.0.0.1:8787/"), "http://127.0.0.1:8787");
  assert.throws(() => normalizeBase("http://127.0.0.1:8787", { allowLocal: false }), /禁止访问/);
  assert.equal(normalizeBase("https://api.z.ai/api/anthropic/"), "https://api.z.ai/api/anthropic");
});

process.stdout.write("providers\n");
test("扫描供应商并标记 Key", () => {
  const providers = scanProviders([]);
  const demo = providers.find((p) => p.id === "demo");
  assert.ok(demo);
  assert.equal(demo.hasKey, true);
  assert.equal(demo.protocol, "anthropic");
  assert.deepEqual(demo.models.sort(), ["demo-large", "demo-small"]);
  assert.equal(providers.find((p) => p.id === "disabled").enabled, false);
});
test("模型标签命中供应商与模型", () => {
  const conn = resolveAuto({ modelLabel: "DemoProvider/demo-small" });
  assert.equal(conn.providerId, "demo");
  assert.equal(conn.model, "demo-small");
  assert.equal(conn.protocol, "anthropic");
  assert.equal(conn.keySource, "provider");
});
test("显式 providerId 优先，模型留空取第一个", () => {
  const conn = resolveAuto({ providerId: "demo" });
  assert.equal(conn.model, "demo-large");
});
test("找不到供应商时报可读错误", () => {
  assert.throws(() => resolveAuto({ providerId: "missing" }), /不存在或已禁用/);
});
test("localModels 从配置读模型", () => {
  assert.deepEqual(localModels("demo", []), ["demo-large", "demo-small"]);
});

process.stdout.write("config\n");
test("默认配置结构完整", () => {
  const cfg = defaultConfig();
  assert.equal(cfg.port, 9337);
  assert.equal(cfg.llm.mode, "auto");
  assert.equal(cfg.hotkeyEnabled, true);
  assert.equal(cfg.defaultAction, "enhance");
});
test("保存后读回，非法值被归一化", () => {
  saveConfig({ port: 70000, defaultAction: "nope", llm: { mode: "weird", protocol: "x" } });
  const cfg = loadConfig();
  assert.equal(cfg.port, 65535);
  assert.equal(cfg.defaultAction, "enhance");
  assert.equal(cfg.llm.mode, "auto");
  assert.equal(cfg.llm.protocol, "anthropic");
});
test("apiKey 不进页面视图", () => {
  saveConfig({ llm: { apiKey: "sk-secret-value" } });
  const view = clientConfig(loadConfig());
  assert.equal(view.llm.apiKey, undefined);
  assert.equal(view.llm.apiKeySet, true);
  assert.ok(!JSON.stringify(view).includes("sk-secret-value"));
});
test("页面补丁：空 apiKey 不覆盖已有值", () => {
  saveConfig({ llm: { apiKey: "sk-secret-value" } });
  applyClientPatch({ llm: { apiKey: "" } });
  assert.equal(loadConfig().llm.apiKey, "sk-secret-value");
});
test("页面补丁：clearApiKey 才清空", () => {
  applyClientPatch({ llm: { clearApiKey: true } });
  assert.equal(loadConfig().llm.apiKey, "");
});
test("页面补丁：忽略白名单外字段", () => {
  applyClientPatch({ port: 1234, llm: { apiKey: "sk-new" } });
  assert.equal(loadConfig().port, 65535);
  assert.equal(loadConfig().llm.apiKey, "sk-new");
});

process.stdout.write("icon\n");
const { writeIcon } = await import("../lib/icon.mjs");
test("ico 文件可生成", () => {
  const file = path.join(sandbox, "icon.ico");
  writeIcon(file);
  const buf = fs.readFileSync(file);
  assert.ok(buf.length > 1000);
  assert.equal(buf.readUInt16LE(2), 1); // type = icon
  assert.ok(buf.readUInt16LE(4) >= 4);  // 多尺寸
});

try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
