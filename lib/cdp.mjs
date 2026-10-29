/*
CDP 客户端（Node 22+ 原生 WebSocket，零依赖）。
职责：附着页面 target、注入脚本、接收页面 binding 请求、回填输入框。
*/
import { IS_MAC } from "./config.mjs";

export class CdpConnection {
  constructor(wsUrl, { bindingName, onBinding, onLog = () => {} } = {}) {
    this.wsUrl = wsUrl;
    this.bindingName = bindingName;
    this.onBinding = onBinding;
    this.onLog = onLog;
    this.nextId = 1;
    this.pending = new Map();
    this.sessions = new Map(); // targetId -> sessionId
    this.injectSource = "";
    this.closed = false;
  }

  connect(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("连接 CDP 超时")), timeoutMs);
      try {
        this.ws = new WebSocket(this.wsUrl);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
        return;
      }
      this.ws.addEventListener("open", () => { clearTimeout(timer); resolve(); });
      this.ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP WebSocket 连接失败")); });
      this.ws.addEventListener("close", () => {
        this.closed = true;
        for (const { reject: fail } of this.pending.values()) fail(new Error("CDP 连接已关闭"));
        this.pending.clear();
      });
      this.ws.addEventListener("message", (event) => this.#onMessage(event.data));
    });
  }

  #onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`CDP ${msg.error.message || "调用失败"}`));
      else entry.resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.bindingCalled" && msg.params?.name === this.bindingName) {
      this.onBinding?.(msg.sessionId, msg.params.payload);
    } else if (msg.method === "Target.attachedToTarget") {
      void this.#onAttached(msg.params);
    } else if (msg.method === "Target.targetDestroyed") {
      this.sessions.delete(msg.params?.targetId);
    }
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error("CDP 连接已关闭"));
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify(message)); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  async attachAll() {
    await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const { targetInfos = [] } = await this.send("Target.getTargets");
    for (const info of targetInfos) {
      if (info.type !== "page" && info.type !== "webview") continue;
      try { await this.send("Target.attachToTarget", { targetId: info.targetId, flatten: true }); }
      catch (error) { this.onLog(`附着页面失败：${error.message}`); }
    }
  }

  async #onAttached(params) {
    const info = params?.targetInfo;
    if (!info || (info.type !== "page" && info.type !== "webview")) return;
    if (this.sessions.has(info.targetId)) return;
    const sessionId = params.sessionId;
    this.sessions.set(info.targetId, sessionId);
    try {
      await this.send("Runtime.enable", {}, sessionId);
      await this.send("Runtime.addBinding", { name: this.bindingName }, sessionId);
      await this.send("Page.enable", {}, sessionId);
      if (this.injectSource) {
        // 新文档自动注入 + 当前文档立即注入（脚本幂等）
        await this.send("Page.addScriptToEvaluateOnNewDocument", { source: this.injectSource }, sessionId);
        await this.send("Runtime.evaluate", { expression: this.injectSource }, sessionId);
      }
      this.onLog(`已注入页面 ${info.targetId}`);
      // 告知页面控制器已就绪（页面可能在注入时控制器还没准备好）
      await this.send("Runtime.evaluate", { expression: "window.__zcodeSparkPing && window.__zcodeSparkPing()" }, sessionId).catch(() => {});
    } catch (error) {
      this.onLog(`注入页面失败：${error.message}`);
    }
  }

  async evaluate(sessionId, expression, { awaitPromise = false } = {}) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true }, sessionId);
    return result?.result?.value;
  }

  reply(sessionId, requestId, payload) {
    const expression = `window.__zcodeSparkReply && window.__zcodeSparkReply(${Number(requestId) || 0}, ${JSON.stringify(JSON.stringify(payload))})`;
    return this.send("Runtime.evaluate", { expression }, sessionId).catch((error) => {
      this.onLog(`回复页面失败：${error.message}`);
    });
  }

  /**
   * 回填富文本编辑器：受信全选（Ctrl/Cmd+A）+ 受信插入。
   * Lexical 一类受控编辑器只认真实输入管线，程序化选区与合成事件会被丢弃或追加。
   */
  async insertText(sessionId, text) {
    const modifiers = IS_MAC ? 4 : 2;
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers,
    }, sessionId);
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers,
    }, sessionId);
    await this.send("Input.insertText", { text }, sessionId);
  }

  waitForClose() {
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (this.closed) { clearInterval(timer); resolve(); }
      }, 1000);
    });
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}
