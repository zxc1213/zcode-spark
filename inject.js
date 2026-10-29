/*
ZCode Spark 页面运行时（由控制器通过 CDP 注入，幂等）。
- 在输入框左下角模式切换右侧注入一颗星芒按钮：点击弹出动作菜单，右键直接开设置
- 快捷键默认 Ctrl+Shift+E，触发默认动作
- 结果经控制器回填输入框（受信全选 + 受信插入），支持多步撤销
- 草稿在请求期间被改动时不回填，改为复制到剪贴板，原文永不丢
*/
(() => {
  const VERSION = globalThis.__zcodeSparkVersion || "dev";
  const RUNTIME_KEY = "__zcodeSparkRuntime";
  if (window[RUNTIME_KEY] === VERSION) return;
  if (typeof window.__zcodeSparkDispose === "function") {
    try { window.__zcodeSparkDispose(); } catch {}
  }

  const ID = {
    root: "zspark-root",
    button: "zspark-btn",
    undo: "zspark-undo",
    menu: "zspark-menu",
    panel: "zspark-panel",
    toast: "zspark-toast",
    style: "zspark-style",
  };
  const REQUEST_TIMEOUT_MS = 95000;
  const POLL_MS = 700;

  const COMPOSER_SELECTORS = [
    '[data-testid="v4-composer"]',
    '[data-testid="chat-composer"]',
    '[data-testid="chat-input"]',
  ];
  const INPUT_SELECTORS = [
    '[data-testid="v4-composer-input"]',
    '[data-testid="chat-input"]',
  ];
  const ANCHOR_SELECTORS = [
    '[data-testid="chat-mode-select-trigger"]',
    '[data-testid="chat-thought-level-select-trigger"]',
    '[data-testid="chat-attachment-button"]',
    '[data-testid="v4-composer-cua-entry"]',
    '[data-testid="chat-send-button"]',
    '[data-testid="v4-composer-send"]',
  ];
  const MODEL_LABEL_SELECTORS = [
    '[data-testid="chat-model-select-trigger"]',
    '[data-testid="v4-model-config"]',
  ];

  const ICONS = {
    sparkle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/></svg>',
    spinner: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>',
    undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h9a6 6 0 0 1 0 12h-3"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    enhance: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18 16l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/></svg>',
    concise: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h10M4 17h7"/></svg>',
    structure: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h4M4 12h4M4 18h4"/><path d="M11 6h9M11 12h9M11 18h6"/></svg>',
    english: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h10M9 5v2c0 4-2 7-5 9"/><path d="M5 9h8"/><path d="M13 20l4-10 4 10"/><path d="M14.5 16.5h5"/></svg>',
    proofread: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h9M4 12h6M4 18h5"/><path d="M14 17l2.5 2.5L21 14"/></svg>',
  };

  const listeners = [];
  function listen(target, event, handler, options) {
    target.addEventListener(event, handler, options);
    listeners.push(() => target.removeEventListener(event, handler, options));
  }

  // ---- 设置缓存（连接配置由控制器持有，页面只缓存展示副本）----
  let settings = { defaultAction: "enhance", hotkey: "Ctrl+Shift+E", hotkeyEnabled: true, llm: { mode: "auto" } };
  let actions = [
    { id: "enhance", label: "增强", hint: "补全目标、范围与约束" },
    { id: "concise", label: "精简", hint: "去掉冗余，只留硬约束" },
    { id: "structure", label: "结构化", hint: "整理成目标/约束/交付物/验收" },
    { id: "english", label: "中译英", hint: "转成地道英文提示词" },
    { id: "proofread", label: "纠错", hint: "只改错别字与语病" },
  ];
  let connected = false;
  let busyId = 0;
  const history = [];
  const pending = new Map();
  let requestSeq = 0;
  let lastReply = null;
  let lastWrite = null;
  const nextId = () => ++requestSeq;

  window.__zcodeSparkReply = function reply(id, payloadJson) {
    lastReply = { id: Number(id), at: Date.now() };
    const entry = pending.get(Number(id));
    if (!entry) return;
    pending.delete(Number(id));
    let data;
    try { data = JSON.parse(payloadJson); } catch { data = { ok: false, error: "控制器返回了无效数据" }; }
    if (data && data.ok) entry.resolve(data);
    else entry.reject(new Error((data && data.error) || "控制器处理失败"));
  };

  function request(type, extra = {}, id = nextId()) {
    if (typeof window.__zcodeSpark !== "function") {
      return Promise.reject(new Error("控制器未连接：请从「ZCode Spark」入口启动"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("请求超时（95 秒），原文已保留"));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try {
        window.__zcodeSpark(JSON.stringify({ id, type, ...extra }));
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`无法联系控制器：${error?.message || error}`));
      }
    });
  }

  function readWorkspacePaths() {
    try {
      const prefix = "zcode-v4-last-session:v1:";
      return Object.keys(localStorage)
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
        .filter((p) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/"));
    } catch { return []; }
  }

  function readModelLabel() {
    for (const selector of MODEL_LABEL_SELECTORS) {
      const node = document.querySelector(selector);
      const label = (node?.textContent || "").trim();
      if (label && label.length < 80) return label;
    }
    return "";
  }

  // ---- composer 定位 ----
  function isVisible(node) {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function findComposerScope() {
    const scopes = [];
    for (const selector of COMPOSER_SELECTORS) {
      for (const node of document.querySelectorAll(selector)) {
        if (node && isVisible(node) && !scopes.includes(node)) scopes.push(node);
      }
    }
    if (!scopes.length) return null;
    const focused = scopes.find((scope) => scope.contains(document.activeElement));
    if (focused) return focused;
    return scopes.reduce((best, node) => (node.getBoundingClientRect().top > best.getBoundingClientRect().top ? node : best), scopes[0]);
  }
  function findComposerInput() {
    for (const selector of INPUT_SELECTORS) {
      const node = document.querySelector(selector);
      if (node && isVisible(node) && (node.tagName === "TEXTAREA" || node.isContentEditable)) return node;
    }
    const scope = findComposerScope();
    const root = scope || document;
    const nodes = [...root.querySelectorAll('textarea, [contenteditable="true"]')]
      .filter((node) => !node.closest(`#${ID.root}, #${ID.menu}, #${ID.panel}`)
        && isVisible(node) && !node.disabled && !node.readOnly);
    let best = null;
    let bestTop = -Infinity;
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 24) continue;
      if (scope && !scope.contains(node)) continue;
      if (rect.top < window.innerHeight * 0.3) continue;
      if (rect.top > bestTop) { bestTop = rect.top; best = node; }
    }
    return best;
  }
  function readText(node) {
    if (node.tagName === "TEXTAREA" || node.tagName === "INPUT") return node.value;
    return node.innerText || node.textContent || "";
  }
  const normalize = (value) => String(value ?? "").replace(/\r\n?/g, "\n").replace(/[\s\u00a0]+$/u, "");
  function sameText(a, b) { return normalize(a) === normalize(b); }
  // 编辑器接受度校验用宽松比较：只关心行内容与顺序，容忍空行/行尾空白差异
  // （富文本编辑器把连续的 \n 拆成 block + <br>，回读出的空行数与写入值天然有出入）
  const canonical = (value) => String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
    .join("\n")
    .trim();
  function sameContent(a, b) { return canonical(a) === canonical(b); }

  function selectAll(node) {
    node.focus({ preventScroll: true });
    const selection = window.getSelection();
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.addRange(range);
  }
  function placeCaretEnd(node) {
    if (node.tagName === "TEXTAREA" || node.tagName === "INPUT") {
      try { node.setSelectionRange(node.value.length, node.value.length); } catch {}
      return;
    }
    try {
      node.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(node);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } catch {}
  }

  function waitText(node, text, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      (function poll() {
        if (sameContent(readText(node), text)) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(poll, 40);
      })();
    });
  }

  async function writeText(node, text) {
    const value = String(text).replace(/\r\n?/g, "\n");
    const record = (expected, received, matched) => {
      lastWrite = { expected: expected.slice(0, 400), received: received.slice(0, 400), matched };
      return matched;
    };
    if (node.tagName === "TEXTAREA" || node.tagName === "INPUT") {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value");
      if (descriptor?.set) descriptor.set.call(node, value);
      else node.value = value;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      return record(value, readText(node), sameText(readText(node), value));
    }
    node.focus({ preventScroll: true });
    // 通道一：控制器受信全选 + 受信插入（受控富文本编辑器唯一可靠通道）
    if (document.activeElement === node && typeof window.__zcodeSpark === "function") {
      try {
        await request("insert", { text: value });
        if (await waitText(node, value, 1500)) return record(value, readText(node), true);
      } catch {}
    }
    // 通道二：合成粘贴
    try {
      selectAll(node);
      const data = new DataTransfer();
      data.setData("text/plain", value);
      node.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
      if (await waitText(node, value, 600)) return record(value, readText(node), true);
    } catch {}
    // 通道三：execCommand + 直接写入兜底
    try {
      selectAll(node);
      document.execCommand("insertText", false, value);
      if (await waitText(node, value, 500)) return record(value, readText(node), true);
    } catch {}
    try {
      node.focus({ preventScroll: true });
      selectAll(node);
      document.execCommand("insertText", false, value);
      if (await waitText(node, value, 500)) return record(value, readText(node), true);
    } catch {}
    return record(value, readText(node), false);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch { return false; }
  }

  // ---- 主题 ----
  function isDark() {
    const parse = (value) => {
      const match = String(value || "").match(/rgba?\(([^)]+)\)/);
      if (!match) return null;
      const parts = match[1].split(",").map((n) => parseFloat(n));
      if (parts.length < 3) return null;
      if (parts.length > 3 && parts[3] < 0.2) return null;
      return parts;
    };
    let node = document.body;
    while (node) {
      const parts = parse(getComputedStyle(node).backgroundColor);
      if (parts) {
        const [r, g, b] = parts;
        return (0.299 * r + 0.587 * g + 0.114 * b) < 140;
      }
      node = node.parentElement;
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  }

  function ensureStyles() {
    if (document.getElementById(ID.style)) return;
    const style = document.createElement("style");
    style.id = ID.style;
    style.textContent = `
      #${ID.root} { display: inline-flex; align-items: center; gap: 2px; flex: 0 0 auto; }
      #${ID.button}, #${ID.undo} {
        display: inline-flex; align-items: center; justify-content: center;
        box-sizing: border-box; width: 30px; min-width: 30px; height: 30px; padding: 0;
        border: 0; border-radius: 8px; background: transparent; color: inherit;
        cursor: pointer; opacity: 1; line-height: 1; transition: background .15s ease;
      }
      #${ID.button}:hover, #${ID.undo}:hover:not(:disabled) { background: rgba(127,127,127,.20); }
      #${ID.button}[data-open="1"] { background: rgba(127,127,127,.24); }
      #${ID.button} svg, #${ID.undo} svg { display: block; width: 18px; height: 18px; pointer-events: none; }
      #${ID.undo} { width: 26px; min-width: 26px; }
      #${ID.undo} svg { width: 16px; height: 16px; }
      #${ID.undo}[hidden] { display: none !important; }
      #${ID.button} .zspark-spinner { display: none; }
      #${ID.button}[data-loading="1"] .zspark-sparkle { display: none; }
      #${ID.button}[data-loading="1"] .zspark-spinner { display: block; animation: zspark-spin .9s linear infinite; transform-origin: 50% 50%; }
      @keyframes zspark-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }

      #${ID.menu} {
        position: fixed; z-index: 2147483600; box-sizing: border-box; width: 248px;
        padding: 6px; border-radius: 10px; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
        background: var(--zs-bg); color: var(--zs-fg); border: 1px solid var(--zs-border);
        box-shadow: 0 12px 32px rgba(0,0,0,.28); letter-spacing: 0;
      }
      #${ID.menu}, #${ID.menu} * { box-sizing: border-box; }
      #${ID.menu} .zspark-item {
        display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 9px;
        border: 0; border-radius: 7px; background: transparent; color: inherit;
        font: inherit; text-align: left; cursor: pointer;
      }
      #${ID.menu} .zspark-item:hover { background: var(--zs-hover); }
      #${ID.menu} .zspark-item svg { flex: 0 0 17px; width: 17px; height: 17px; opacity: .8; }
      #${ID.menu} .zspark-item .zspark-label { font-weight: 600; }
      #${ID.menu} .zspark-item .zspark-hint { font-weight: 400; color: var(--zs-muted); font-size: 12px; }
      #${ID.menu} .zspark-sep { height: 1px; margin: 5px 4px; background: var(--zs-border); }

      #${ID.toast} {
        position: fixed; left: 50%; bottom: 132px; transform: translateX(-50%);
        z-index: 2147483647; display: flex; align-items: center; gap: 8px;
        max-width: min(600px, calc(100vw - 32px)); padding: 8px 14px; border-radius: 9px;
        font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
        background: rgba(32,34,40,.95); color: #fff; box-shadow: 0 6px 20px rgba(0,0,0,.3);
        opacity: 0; visibility: hidden; transition: opacity .16s ease; pointer-events: none;
        overflow-wrap: anywhere;
      }
      #${ID.toast}[data-show="1"] { opacity: 1; visibility: visible; }
      #${ID.toast}[data-kind="err"] { background: rgba(158,42,42,.96); }
      #${ID.toast}[data-kind="warn"] { background: rgba(146,96,20,.96); }

      #${ID.panel} {
        position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center;
        padding: 16px; background: rgba(0,0,0,.38); color-scheme: light dark;
        font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      #${ID.panel}, #${ID.panel} * { box-sizing: border-box; letter-spacing: 0; }
      #${ID.panel} .zspark-box {
        width: 600px; max-width: 100%; max-height: calc(100dvh - 32px); display: flex; flex-direction: column;
        overflow: hidden; border-radius: 10px; background: var(--zs-bg); color: var(--zs-fg);
        border: 1px solid var(--zs-border); box-shadow: 0 18px 48px rgba(0,0,0,.35);
      }
      #${ID.panel} .zspark-head, #${ID.panel} .zspark-foot {
        display: flex; align-items: center; gap: 10px; padding: 13px 18px; flex: 0 0 auto;
      }
      #${ID.panel} .zspark-head { border-bottom: 1px solid var(--zs-border); }
      #${ID.panel} .zspark-head h3 { margin: 0; font-size: 15px; font-weight: 650; flex: 1; }
      #${ID.panel} .zspark-head h3 span { font-weight: 400; font-size: 12px; color: var(--zs-muted); margin-left: 6px; }
      #${ID.panel} .zspark-body { padding: 16px 18px; overflow-y: auto; min-height: 0; }
      #${ID.panel} section + section { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--zs-border); }
      #${ID.panel} h4 { margin: 0 0 10px; font-size: 13px; font-weight: 650; }
      #${ID.panel} .zspark-grid { display: grid; grid-template-columns: 92px minmax(0,1fr); gap: 10px; align-items: center; }
      #${ID.panel} label { font-weight: 500; }
      #${ID.panel} input:not([type="checkbox"]):not([type="radio"]), #${ID.panel} select {
        width: 100%; min-width: 0; height: 34px; padding: 0 9px; border-radius: 7px;
        border: 1px solid var(--zs-border); background: transparent; color: inherit; font: inherit;
      }
      #${ID.panel} input[type="checkbox"], #${ID.panel} input[type="radio"] { accent-color: var(--zs-accent); margin: 0; }
      #${ID.panel} .zspark-radios { display: flex; gap: 16px; }
      #${ID.panel} .zspark-radios label { display: flex; align-items: center; gap: 6px; font-weight: 400; cursor: pointer; }
      #${ID.panel} .zspark-hint { margin: 8px 0 0; font-size: 12px; color: var(--zs-muted); }
      #${ID.panel} .zspark-row { display: flex; gap: 8px; align-items: center; }
      #${ID.panel} button.zspark-act {
        height: 32px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--zs-border);
        background: transparent; color: inherit; font: inherit; cursor: pointer; white-space: nowrap;
      }
      #${ID.panel} button.zspark-act:hover { background: var(--zs-hover); }
      #${ID.panel} button.zspark-primary {
        height: 32px; padding: 0 16px; border-radius: 7px; border: 1px solid transparent;
        background: var(--zs-accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer;
      }
      #${ID.panel} button.zspark-primary:hover { filter: brightness(1.08); }
      #${ID.panel} .zspark-status { margin-top: 10px; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--zs-muted); min-height: 34px; }
      #${ID.panel} .zspark-runs { margin: 0; padding: 0; list-style: none; font-size: 12px; color: var(--zs-muted); }
      #${ID.panel} .zspark-runs li { padding: 2px 0; overflow-wrap: anywhere; }
      #${ID.panel} .zspark-icon-btn {
        width: 30px; height: 30px; padding: 0; border: 0; border-radius: 7px; background: transparent;
        color: inherit; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
      }
      #${ID.panel} .zspark-icon-btn:hover { background: var(--zs-hover); }
      #${ID.panel} .zspark-icon-btn svg { width: 17px; height: 17px; }
    `;
    document.head.appendChild(style);
  }

  function applyTheme(node) {
    const dark = isDark();
    node.style.setProperty("--zs-bg", dark ? "#24262b" : "#ffffff");
    node.style.setProperty("--zs-fg", dark ? "#e6e8ec" : "#1f2328");
    node.style.setProperty("--zs-border", dark ? "rgba(255,255,255,.16)" : "rgba(0,0,0,.12)");
    node.style.setProperty("--zs-hover", dark ? "rgba(255,255,255,.10)" : "rgba(0,0,0,.06)");
    node.style.setProperty("--zs-muted", dark ? "#9aa1ab" : "#6b7280");
    node.style.setProperty("--zs-accent", dark ? "#8b8bfa" : "#5b5bf7");
  }

  // ---- 提示条 ----
  let toastTimer = 0;
  function toast(message, kind = "info", ms = 4200) {
    let node = document.getElementById(ID.toast);
    if (!node) {
      node = document.createElement("div");
      node.id = ID.toast;
      document.body.appendChild(node);
    }
    node.textContent = message;
    node.dataset.kind = kind;
    node.dataset.show = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.dataset.show = "0"; }, ms);
  }

  // ---- 按钮与菜单 ----
  function findAnchor(scope) {
    if (!scope) return null;
    const containers = [scope, scope.parentElement, scope.parentElement?.parentElement];
    for (let depth = 0; depth < containers.length; depth++) {
      const node = containers[depth];
      if (!node) continue;
      for (const selector of ANCHOR_SELECTORS) {
        const anchor = node.querySelector(selector);
        if (!anchor || !isVisible(anchor)) continue;
        if (depth > 0 && anchor.closest(COMPOSER_SELECTORS.join(",")) !== scope) continue;
        return { anchor, after: !/send/.test(selector) };
      }
    }
    return null;
  }

  function ensureMounted() {
    if (!document.body) return;
    ensureStyles();
    const existing = document.getElementById(ID.root);
    if (existing && existing.isConnected) {
      if (!existing.querySelector(`#${ID.undo}`)) existing.appendChild(buildUndoButton());
      return;
    }
    closeMenu();
    const scope = findComposerScope();
    const found = findAnchor(scope);
    if (!found) return;
    const root = document.createElement("span");
    root.id = ID.root;
    root.appendChild(buildButton());
    root.appendChild(buildUndoButton());
    if (found.after) found.anchor.insertAdjacentElement("afterend", root);
    else found.anchor.insertAdjacentElement("beforebegin", root);
    updateUndo();
  }

  function buildButton() {
    const button = document.createElement("button");
    button.id = ID.button;
    button.type = "button";
    button.title = "ZCode Spark：改写提示词（右键设置）";
    button.setAttribute("aria-label", "ZCode Spark");
    button.innerHTML = `<span class="zspark-sparkle">${ICONS.sparkle}</span><span class="zspark-spinner">${ICONS.spinner}</span>`;
    listen(button, "click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (busyId) {
        void request("cancel", { targetId: busyId });
        return;
      }
      if (document.getElementById(ID.menu)) closeMenu();
      else openMenu(button);
    });
    listen(button, "contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void openPanel();
    });
    return button;
  }

  function buildUndoButton() {
    const button = document.createElement("button");
    button.id = ID.undo;
    button.type = "button";
    button.hidden = true;
    button.title = "撤销本轮的改写（不请求模型）";
    button.innerHTML = ICONS.undo;
    listen(button, "click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void undo();
    });
    return button;
  }

  function closeMenu() {
    document.getElementById(ID.menu)?.remove();
    document.getElementById(ID.button)?.removeAttribute("data-open");
  }

  function openMenu(button) {
    closeMenu();
    const menu = document.createElement("div");
    menu.id = ID.menu;
    applyTheme(menu);
    for (const action of actions) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "zspark-item";
      item.dataset.action = action.id;
      item.innerHTML = `${ICONS[action.id] || ICONS.enhance}<span><span class="zspark-label">${action.label}</span><br><span class="zspark-hint">${action.hint}</span></span>`;
      listen(item, "click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        void runAction(action.id);
      });
      menu.appendChild(item);
    }
    const sep = document.createElement("div");
    sep.className = "zspark-sep";
    menu.appendChild(sep);
    const settingsItem = document.createElement("button");
    settingsItem.type = "button";
    settingsItem.className = "zspark-item";
    settingsItem.innerHTML = `${ICONS.settings}<span><span class="zspark-label">设置</span><br><span class="zspark-hint">连接、默认动作、快捷键</span></span>`;
    listen(settingsItem, "click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      void openPanel();
    });
    menu.appendChild(settingsItem);

    menu.style.visibility = "hidden";
    document.body.appendChild(menu);
    const rect = button.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    const top = rect.top - height - 8 > 8 ? rect.top - height - 8 : Math.min(rect.bottom + 8, window.innerHeight - height - 8);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = "visible";
    button.dataset.open = "1";

    setTimeout(() => {
      const onDown = (event) => {
        if (menu.contains(event.target)) return;
        closeMenu();
        document.removeEventListener("mousedown", onDown, true);
        document.removeEventListener("keydown", onKey, true);
      };
      const onKey = (event) => {
        if (event.key !== "Escape") return;
        closeMenu();
        document.removeEventListener("mousedown", onDown, true);
        document.removeEventListener("keydown", onKey, true);
      };
      document.addEventListener("mousedown", onDown, true);
      document.addEventListener("keydown", onKey, true);
    }, 0);
  }

  // ---- 主流程 ----
  function setLoading(on) {
    const button = document.getElementById(ID.button);
    if (button) button.dataset.loading = on ? "1" : "0";
  }

  function updateUndo() {
    const button = document.getElementById(ID.undo);
    if (!button) return;
    button.hidden = history.length === 0;
    button.title = history.length ? `撤销（还可撤销 ${history.length} 步）` : "没有可撤销的改写";
  }

  async function applyText(text) {
    const input = findComposerInput();
    if (!input) throw new Error("找不到输入框");
    const ok = await writeText(input, text);
    if (!ok) throw new Error("输入框没有完整接受改写结果，原文已保留");
    placeCaretEnd(input);
  }

  async function runAction(actionId) {
    if (busyId) return;
    const input = findComposerInput();
    if (!input) { toast("找不到输入框，点一下输入区再试", "err"); return; }
    const draft = readText(input).trim();
    if (!draft) { toast("草稿为空，先写点什么", "err"); return; }
    const snapshot = { text: readText(input), route: location.href };
    const id = nextId();
    busyId = id;
    const startedAt = Date.now();
    setLoading(true);
    try {
      const response = await request("run", {
        action: actionId,
        draft,
        modelLabel: readModelLabel(),
        workspacePaths: readWorkspacePaths(),
      }, id);
      const target = input.isConnected ? input : findComposerInput();
      const current = target ? readText(target) : "";
      const unchanged = target && target.isConnected && location.href === snapshot.route && sameText(current, snapshot.text);
      if (!unchanged) {
        const copied = await copyText(response.text);
        toast(`草稿已变化，未回填${copied ? "；结果已复制到剪贴板" : "（复制失败，可在设置里查看）"}`, "warn", 6000);
        return;
      }
      const ok = await writeText(target, response.text);
      if (!ok) throw new Error("输入框没有完整接受改写结果，原文已保留");
      placeCaretEnd(target);
      history.push({ before: snapshot.text, after: response.text, action: actionId });
      if (history.length > 20) history.shift();
      updateUndo();
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const meta = response.meta || {};
      toast(`${labelOf(actionId)}完成 · ${draft.length} → ${response.text.length} 字 · ${seconds}s${meta.model ? ` · ${meta.model}` : ""}`);
    } catch (error) {
      const message = String(error?.message || error);
      if (/取消/.test(message)) toast("已取消，原文未变");
      else toast(message, "err", 6500);
    } finally {
      busyId = 0;
      setLoading(false);
    }
  }

  async function undo() {
    const entry = history[history.length - 1];
    if (!entry) return;
    if (busyId) return;
    try {
      await applyText(entry.before);
      history.pop();
      updateUndo();
      toast("已撤销到改写前的文案");
    } catch (error) {
      toast(String(error?.message || error), "err", 6000);
    }
  }

  function labelOf(id) {
    return actions.find((action) => action.id === id)?.label || "改写";
  }

  // ---- 设置面板 ----
  function closePanel() {
    document.getElementById(ID.panel)?.remove();
  }

  function field(labelText, control) {
    const label = document.createElement("label");
    label.textContent = labelText;
    const wrap = document.createElement("div");
    wrap.appendChild(control);
    return [label, wrap];
  }

  function makeInput(value = "", attrs = {}) {
    const input = document.createElement("input");
    input.value = value;
    for (const [key, val] of Object.entries(attrs)) {
      if (key === "list") input.setAttribute("list", val);
      else if (key === "placeholder") input.placeholder = val;
      else if (key === "type") input.type = val;
      else input[key] = val;
    }
    return input;
  }

  function makeSelect(options, value) {
    const select = document.createElement("select");
    for (const option of options) {
      const node = document.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      select.appendChild(node);
    }
    select.value = value;
    return select;
  }

  async function openPanel() {
    closePanel();
    const overlay = document.createElement("div");
    overlay.id = ID.panel;
    applyTheme(overlay);
    overlay.innerHTML = `<div class="zspark-box"><div class="zspark-head"><h3>ZCode Spark<span>v${VERSION}</span></h3><button class="zspark-icon-btn" data-role="close" title="关闭">${ICONS.close}</button></div><div class="zspark-body"><p class="zspark-hint">正在读取配置…</p></div><div class="zspark-foot" style="justify-content:flex-end"></div></div>`;
    document.body.appendChild(overlay);
    const panel = overlay;
    listen(panel, "mousedown", (event) => { if (event.target === panel) closePanel(); });
    listen(panel, "click", (event) => {
      if (event.target.closest('[data-role="close"]')) closePanel();
    });
    listen(panel, "keydown", (event) => { if (event.key === "Escape") closePanel(); });

    let config;
    let providers = [];
    try {
      const [configResponse, providerResponse] = await Promise.all([
        request("config"),
        request("providers", { workspacePaths: readWorkspacePaths() }).catch(() => ({ providers: [] })),
      ]);
      config = configResponse.config;
      providers = providerResponse.providers || [];
    } catch (error) {
      panel.querySelector(".zspark-body").innerHTML = `<p class="zspark-hint">读取配置失败：${String(error?.message || error)}</p>`;
      return;
    }
    renderPanel(panel, config, providers);
  }

  function renderPanel(panel, config, providers) {
    const body = panel.querySelector(".zspark-body");
    const foot = panel.querySelector(".zspark-foot");
    body.innerHTML = "";
    foot.innerHTML = "";

    const llm = config.llm || {};
    const state = {
      mode: llm.mode === "manual" ? "manual" : "auto",
      providerId: llm.providerId || "",
      model: llm.model || "",
      baseUrl: llm.baseUrl || "",
      protocol: llm.protocol || "anthropic",
      apiKey: "",
      clearApiKey: false,
      allowLocal: llm.allowLocal !== false,
      defaultAction: config.defaultAction || "enhance",
      hotkeyEnabled: config.hotkeyEnabled !== false,
      hotkey: config.hotkey || "Ctrl+Shift+E",
    };

    // 连接
    const connectionSection = document.createElement("section");
    const modeRow = document.createElement("div");
    modeRow.className = "zspark-radios";
    for (const [value, label] of [["auto", "自动（复用 ZCode 供应商）"], ["manual", "手动连接"]]) {
      const labelNode = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "zspark-mode";
      radio.value = value;
      radio.checked = state.mode === value;
      listen(radio, "change", () => { state.mode = value; syncVisibility(); });
      labelNode.appendChild(radio);
      labelNode.appendChild(document.createTextNode(label));
      modeRow.appendChild(labelNode);
    }
    connectionSection.innerHTML = `<h4>连接</h4>`;
    connectionSection.appendChild(modeRow);

    const autoBox = document.createElement("div");
    autoBox.className = "zspark-grid";
    autoBox.style.marginTop = "12px";
    const providerSelect = makeSelect(
      [{ value: "", label: "跟随输入框当前模型" }, ...providers.map((p) => ({
        value: p.id,
        label: `${p.name}${p.enabled ? "" : "（禁用）"}${p.hasKey ? "" : "（无Key）"}`,
      }))],
      state.providerId,
    );
    listen(providerSelect, "change", () => { state.providerId = providerSelect.value; });
    const modelInput = makeInput(state.model, { list: "zspark-models", placeholder: "留空 = 用供应商第一个模型" });
    listen(modelInput, "input", () => { state.model = modelInput.value.trim(); });
    const datalist = document.createElement("datalist");
    datalist.id = "zspark-models";
    autoBox.append(...field("供应商", providerSelect), ...field("模型", modelInput));
    autoBox.appendChild(datalist);
    connectionSection.appendChild(autoBox);

    const manualBox = document.createElement("div");
    manualBox.className = "zspark-grid";
    manualBox.style.marginTop = "12px";
    const protocolSelect = makeSelect([
      { value: "anthropic", label: "Anthropic（/v1/messages）" },
      { value: "chat", label: "OpenAI Chat（/v1/chat/completions）" },
      { value: "responses", label: "OpenAI Responses（/v1/responses）" },
    ], state.protocol);
    listen(protocolSelect, "change", () => { state.protocol = protocolSelect.value; });
    const baseInput = makeInput(state.baseUrl, { placeholder: "https://api.example.com/anthropic" });
    listen(baseInput, "input", () => { state.baseUrl = baseInput.value.trim(); });
    const keyInput = makeInput("", {
      type: "password",
      placeholder: llm.apiKeySet ? "已保存（留空不修改）" : "sk-…",
    });
    listen(keyInput, "input", () => { state.apiKey = keyInput.value; state.clearApiKey = false; });
    const manualModelInput = makeInput(state.model, { placeholder: "模型 ID" });
    listen(manualModelInput, "input", () => { state.model = manualModelInput.value.trim(); });
    const keyRow = document.createElement("div");
    keyRow.className = "zspark-row";
    keyRow.appendChild(keyInput);
    if (llm.apiKeySet) {
      const clearLabel = document.createElement("label");
      clearLabel.className = "zspark-hint";
      clearLabel.style.margin = "0";
      clearLabel.style.whiteSpace = "nowrap";
      const clearBox = document.createElement("input");
      clearBox.type = "checkbox";
      listen(clearBox, "change", () => {
        state.clearApiKey = clearBox.checked;
        if (clearBox.checked) { keyInput.value = ""; state.apiKey = ""; }
      });
      clearLabel.append(clearBox, document.createTextNode(" 清除"));
      keyRow.appendChild(clearLabel);
    }
    manualBox.append(
      ...field("协议", protocolSelect),
      ...field("Base URL", baseInput),
      ...field("API Key", keyRow),
      ...field("模型", manualModelInput),
    );
    connectionSection.appendChild(manualBox);

    // 行为
    const behavior = document.createElement("section");
    behavior.innerHTML = `<h4>行为</h4>`;
    const behaviorGrid = document.createElement("div");
    behaviorGrid.className = "zspark-grid";
    const actionSelect = makeSelect(actions.map((a) => ({ value: a.id, label: a.label })), state.defaultAction);
    listen(actionSelect, "change", () => { state.defaultAction = actionSelect.value; });
    const hotkeyWrap = document.createElement("div");
    hotkeyWrap.className = "zspark-row";
    const hotkeyToggle = document.createElement("input");
    hotkeyToggle.type = "checkbox";
    hotkeyToggle.checked = state.hotkeyEnabled;
    listen(hotkeyToggle, "change", () => { state.hotkeyEnabled = hotkeyToggle.checked; });
    const hotkeyText = document.createElement("span");
    hotkeyText.textContent = state.hotkey;
    hotkeyText.style.color = "var(--zs-muted)";
    hotkeyWrap.append(hotkeyToggle, hotkeyText);
    behaviorGrid.append(...field("默认动作", actionSelect), ...field("快捷键", hotkeyWrap));
    behavior.appendChild(behaviorGrid);

    // 诊断
    const diagnostic = document.createElement("section");
    diagnostic.innerHTML = `<h4>诊断</h4>`;
    const status = document.createElement("div");
    status.className = "zspark-status";
    status.textContent = "提示：测试连接只验证鉴权与目录，不消耗生成额度。";
    const runsList = document.createElement("ul");
    runsList.className = "zspark-runs";
    const testButton = document.createElement("button");
    testButton.type = "button";
    testButton.className = "zspark-act";
    testButton.textContent = "保存并测试连接";
    listen(testButton, "click", async () => {
      try {
        await save();
        status.textContent = "测试中…";
        const result = await request("test", { modelLabel: readModelLabel(), workspacePaths: readWorkspacePaths() });
        const conn = result.connection || {};
        status.textContent = `${result.message}\n${conn.providerName || ""} / ${conn.model || ""} / ${conn.protocol || ""} / ${conn.baseUrl || ""}`;
      } catch (error) {
        status.textContent = `测试失败：${String(error?.message || error)}`;
      }
    });
    const pullButton = document.createElement("button");
    pullButton.type = "button";
    pullButton.className = "zspark-act";
    pullButton.textContent = "拉取模型列表";
    listen(pullButton, "click", async () => {
      try {
        await save();
        status.textContent = "拉取中…";
        const result = await request("models", { modelLabel: readModelLabel(), workspacePaths: readWorkspacePaths() });
        datalist.innerHTML = "";
        for (const id of result.models || []) datalist.appendChild(new Option(id));
        status.textContent = `已拉取 ${(result.models || []).length} 个模型${result.source === "local" ? "（来自本地配置，服务未提供目录）" : ""}，输入框已可联想`;
      } catch (error) {
        status.textContent = `拉取失败：${String(error?.message || error)}`;
      }
    });
    const buttonsRow = document.createElement("div");
    buttonsRow.className = "zspark-row";
    buttonsRow.style.marginTop = "10px";
    buttonsRow.append(testButton, pullButton);
    diagnostic.append(buttonsRow, status, runsList);

    body.append(connectionSection, behavior, diagnostic);

    request("runs").then((result) => {
      runsList.innerHTML = "";
      for (const run of result.runs || []) {
        const item = document.createElement("li");
        const time = new Date(run.at).toLocaleTimeString();
        item.textContent = run.ok
          ? `${time}  ${run.action}  ${run.model}  ${run.ms}ms  ${run.chars} 字`
          : `${time}  ${run.action}  失败：${run.error}`;
        runsList.appendChild(item);
      }
      if (!runsList.children.length) runsList.innerHTML = "<li>还没有改写记录</li>";
    }).catch(() => {});

    function syncVisibility() {
      autoBox.hidden = state.mode !== "auto";
      manualBox.hidden = state.mode !== "manual";
    }
    syncVisibility();

    async function save() {
      const patch = {
        defaultAction: state.defaultAction,
        hotkeyEnabled: state.hotkeyEnabled,
        llm: {
          mode: state.mode,
          providerId: state.providerId,
          model: state.model,
          baseUrl: state.baseUrl,
          protocol: state.protocol,
          allowLocal: state.allowLocal,
        },
      };
      if (state.apiKey.trim()) patch.llm.apiKey = state.apiKey.trim();
      if (state.clearApiKey) patch.llm.clearApiKey = true;
      const result = await request("saveConfig", { patch });
      config = result.config;
      settings = { ...settings, ...result.config };
      state.apiKey = "";
      state.clearApiKey = false;
      keyInput.value = "";
      keyInput.placeholder = config.llm?.apiKeySet ? "已保存（留空不修改）" : "sk-…";
      status.textContent = "配置已保存。";
      return result;
    }

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "zspark-act";
    cancelButton.textContent = "关闭";
    listen(cancelButton, "click", () => closePanel());
    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "zspark-primary";
    saveButton.textContent = "保存";
    listen(saveButton, "click", async () => {
      try { await save(); } catch (error) { status.textContent = `保存失败：${String(error?.message || error)}`; }
    });
    foot.append(cancelButton, saveButton);
  }

  // ---- 快捷键 ----
  function matchHotkey(event, combo) {
    const parts = String(combo || "").toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
    const wantCtrl = parts.includes("ctrl") || parts.includes("control");
    const wantShift = parts.includes("shift");
    const wantAlt = parts.includes("alt");
    const wantMeta = parts.includes("meta") || parts.includes("cmd") || parts.includes("win");
    const key = parts[parts.length - 1];
    if (!key) return false;
    if (event.ctrlKey !== wantCtrl) return false;
    if (event.shiftKey !== wantShift) return false;
    if (event.altKey !== wantAlt) return false;
    if (event.metaKey !== wantMeta) return false;
    return String(event.key || "").toLowerCase() === key;
  }

  let pollTimer = 0;
  let handshakeAttempt = 0;

  async function handshake() {
    try {
      const response = await request("hello");
      settings = response.config || settings;
      if (Array.isArray(response.actions) && response.actions.length) actions = response.actions;
      connected = true;
      const button = document.getElementById(ID.button);
      if (button) button.title = `ZCode Spark v${response.version || VERSION}：改写提示词（右键设置）`;
    } catch {
      connected = false;
      if (++handshakeAttempt < 12) setTimeout(handshake, 1500);
    }
  }

  function boot() {
    ensureMounted();
    pollTimer = setInterval(ensureMounted, POLL_MS);
    void handshake();
    listen(window, "keydown", (event) => {
      if (!settings.hotkeyEnabled) return;
      if (!matchHotkey(event, settings.hotkey)) return;
      if (event.isComposing) return;
      event.preventDefault();
      void runAction(settings.defaultAction || "enhance");
    });
  }

  function dispose() {
    clearInterval(pollTimer);
    clearTimeout(toastTimer);
    for (const off of listeners.splice(0)) {
      try { off(); } catch {}
    }
    for (const id of [ID.root, ID.menu, ID.panel, ID.toast, ID.style]) {
      document.getElementById(id)?.remove();
    }
    delete window.__zcodeSparkReply;
    delete window.__zcodeSparkDispose;
    delete window[RUNTIME_KEY];
  }

  window.__zcodeSparkDispose = dispose;
  window[RUNTIME_KEY] = VERSION;
  // 诊断钩子：测试与排错时读取运行时状态（不暴露草稿内容）
  window.__zcodeSparkDebug = () => ({
    version: VERSION,
    connected,
    busyId,
    history: history.length,
    hasUndoButton: Boolean(document.getElementById(ID.undo)),
    undoHidden: document.getElementById(ID.undo)?.hidden ?? null,
    lastToast: document.getElementById(ID.toast)?.textContent || "",
    mounted: Boolean(document.getElementById(ID.root)?.isConnected),
    pendingIds: [...pending.keys()],
    lastReply,
    lastWrite,
  });

  if (document.readyState === "loading") listen(document, "DOMContentLoaded", boot);
  else boot();
})();
