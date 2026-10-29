/*
平台相关：ZCode 路径探测、进程/端口、Windows 消息框与快捷方式。
只实现 Windows；其他平台给明确错误，不做半成品兼容。
*/
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { IS_WIN, SOURCE_ROOT, log } from "./config.mjs";

export function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function psEncoded(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function runPowerShell(script, timeout = 20000) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", psEncoded(script)], {
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
  return { ok: result.status === 0, out: (result.stdout || "").trim(), err: (result.stderr || "").trim() };
}

const DETECT_SCRIPT = `
$out = New-Object System.Collections.ArrayList
foreach ($root in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')) {
  try {
    Get-ItemProperty $root -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*ZCode*' } | ForEach-Object {
      if ($_.InstallLocation) { [void]$out.Add((Join-Path $_.InstallLocation 'ZCode.exe')) }
      if ($_.DisplayIcon) { [void]$out.Add(($_.DisplayIcon -replace ',\\d+$','')) }
    }
  } catch {}
}
try {
  $sh = New-Object -ComObject WScript.Shell
  foreach ($d in @("$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs", "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs")) {
    Get-ChildItem -Path $d -Filter '*ZCode*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
      try { $t = $sh.CreateShortcut($_.FullName).TargetPath; if ($t) { [void]$out.Add($t) } } catch {}
    }
  }
} catch {}
$out | Where-Object { $_ } | Select-Object -Unique | ConvertTo-Json -Compress
`;

function detectFromSystem() {
  if (!IS_WIN) return [];
  const { ok, out } = runPowerShell(DETECT_SCRIPT, 25000);
  if (!ok || !out) return [];
  try {
    const parsed = JSON.parse(out);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((p) => typeof p === "string");
  } catch { return []; }
}

function driveRoots() {
  if (!IS_WIN) return [];
  const roots = [];
  for (let code = "C".charCodeAt(0); code <= "Z".charCodeAt(0); code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    try { if (fs.existsSync(root)) roots.push(root); } catch {}
  }
  return roots;
}

/**
 * 探测 ZCode.exe。优先级：环境变量 > 配置文件 > 系统注册表/开始菜单 > 常见目录 > PATH。
 * @returns {{path:string, source:string} | {error:string, tried:string[]}}
 */
export function findZcodePath(configPathValue = "") {
  const tried = [];
  const envPath = String(process.env.ZCODE_SPARK_ZCODE_PATH || "").trim();
  const candidates = [
    [envPath, "env"],
    [configPathValue, "config"],
    [path.join(SOURCE_ROOT, "ZCode.exe"), "install-dir"],
    [path.join(process.env.LOCALAPPDATA || "", "Programs", "ZCode", "ZCode.exe"), "localappdata"],
    ["C:\\Program Files\\ZCode\\ZCode.exe", "program-files"],
    ["C:\\Program Files (x86)\\ZCode\\ZCode.exe", "program-files"],
  ];
  for (const [candidate, source] of candidates) {
    if (!candidate) continue;
    tried.push(candidate);
    if (isFile(candidate)) return { path: path.resolve(candidate), source };
  }
  for (const candidate of detectFromSystem()) {
    if (!candidate) continue;
    tried.push(candidate);
    if (/\.exe$/i.test(candidate) && isFile(candidate)) return { path: path.resolve(candidate), source: "system" };
  }
  for (const root of driveRoots()) {
    for (const sub of ["zcode\\ZCode.exe", "ZCode\\ZCode.exe", "Program Files\\ZCode\\ZCode.exe"]) {
      const candidate = path.join(root, sub);
      tried.push(candidate);
      if (isFile(candidate)) return { path: path.resolve(candidate), source: "drive-scan" };
    }
  }
  const where = spawnSync("where.exe", ["ZCode.exe"], { encoding: "utf8", windowsHide: true });
  for (const line of String(where.stdout || "").split(/\r?\n/)) {
    const candidate = line.trim();
    if (candidate && isFile(candidate)) return { path: path.resolve(candidate), source: "path" };
  }
  return {
    error: "未找到 ZCode.exe。请在本工具安装目录的 zcode-spark-config.json 里填写 zcodePath，或设置环境变量 ZCODE_SPARK_ZCODE_PATH",
    tried,
  };
}

export function zcodeProcessesRunning() {
  if (!IS_WIN) return false;
  const result = spawnSync("tasklist.exe", ["/FI", "IMAGENAME eq ZCode.exe", "/NH"], { encoding: "utf8", windowsHide: true });
  return /ZCode\.exe/i.test(String(result.stdout || ""));
}

export function killZcodeProcesses() {
  if (!IS_WIN) return false;
  log("关闭正在运行的 ZCode（用户已确认）");
  const result = spawnSync("taskkill.exe", ["/IM", "ZCode.exe", "/T", "/F"], { encoding: "utf8", windowsHide: true });
  return result.status === 0;
}

export function activateZcode() {
  if (!IS_WIN) return;
  runPowerShell(`try { (New-Object -ComObject WScript.Shell).AppActivate('ZCode') | Out-Null } catch {}`, 5000);
}

export function askYesNo(text, title = "ZCode Spark") {
  if (!IS_WIN) return false;
  const escaped = text.replace(/'/g, "''");
  const script = `Add-Type -AssemblyName System.Windows.Forms
$r = [System.Windows.Forms.MessageBox]::Show('${escaped}', '${title.replace(/'/g, "''")}', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)
Write-Output $r`;
  const { out } = runPowerShell(script, 0);
  return /^Yes$/i.test(out.trim());
}

export function notify(text, title = "ZCode Spark") {
  if (IS_WIN) {
    const escaped = String(text).replace(/'/g, "''");
    const script = `Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show('${escaped}', '${title.replace(/'/g, "''")}', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null`;
    runPowerShell(script, 0);
    return;
  }
  log(text);
}

export function createShortcut({ lnkPath, target, args = "", workdir = "", icon = "", description = "" }) {
  if (!IS_WIN) return false;
  const q = (v) => String(v).replace(/'/g, "''");
  const script = `$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut('${q(lnkPath)}')
$lnk.TargetPath = '${q(target)}'
$lnk.Arguments = '${q(args)}'
$lnk.WorkingDirectory = '${q(workdir)}'
${icon ? `$lnk.IconLocation = '${q(icon)}'` : ""}
$lnk.Description = '${q(description)}'
$lnk.Save()`;
  const { ok } = runPowerShell(script, 15000);
  return ok;
}

function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

export async function findFreePort(preferred, span = 24) {
  for (let i = 0; i <= span; i++) {
    const port = preferred + i;
    if (port > 65535) break;
    if (await canBind(port)) return port;
  }
  throw new Error(`端口 ${preferred}-${preferred + span} 都被占用，请修改配置里的 port`);
}

export async function cdpVersion(port, timeoutMs = 3000) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.webSocketDebuggerUrl ? data : null;
  } catch { return null; }
}

export function desktopPath() {
  return path.join(os.homedir(), "Desktop");
}

export function resolveNodePath() {
  return process.execPath;
}
