#!/usr/bin/env node
/*
安装器：
- 复制程序到 %LOCALAPPDATA%\ZCodeSpark（可用 --dest 或 ZCODE_SPARK_DEST 覆盖）
- 生成星芒图标与无窗口启动器 launcher.vbs（把当前 node 路径写死，双击即用）
- 首次安装写入配置并探测 ZCode.exe 路径
- 桌面创建「ZCode Spark」快捷方式；不改动原 ZCode 的任何文件

重复运行 = 覆盖程序文件，保留已有配置。
用法：node install.mjs [--dest <目录>] [--no-shortcut]
*/
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultConfig, readJson } from "./lib/config.mjs";
import { writeIcon } from "./lib/icon.mjs";
import { createShortcut, desktopPath, findZcodePath, resolveNodePath } from "./lib/platform.mjs";

const SOURCE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const destFlag = (() => {
  const index = argv.indexOf("--dest");
  return index >= 0 && argv[index + 1] ? argv[index + 1] : "";
})();
const DEST = path.resolve(destFlag || process.env.ZCODE_SPARK_DEST || path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "ZCodeSpark",
));
const skipShortcut = argv.includes("--no-shortcut");

const FILES = ["controller.mjs", "inject.js", "start-zcode-spark.bat", "README.md", "LICENSE"];
const CONFIG_FILE = path.join(DEST, "zcode-spark-config.json");
const LOG_FILE = path.join(DEST, "zcode-spark.log");

function copyFile(name) {
  const from = path.join(SOURCE, name);
  if (!fs.existsSync(from)) return false;
  fs.copyFileSync(from, path.join(DEST, name));
  return true;
}

const LAUNCHER = (nodePath) => `Option Explicit
' 由 install.mjs 生成：无窗口启动 ZCode Spark 控制器（node 路径已写死，node 升级后重跑安装）
Dim shell, fso, dir, node, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = dir
node = "${nodePath.replace(/"/g, "")}"
If Not fso.FileExists(node) Then node = "node.exe"
cmd = """" & node & """ """ & dir & "\\controller.mjs"""
shell.Run cmd, 0, False
`;

function main() {
  fs.mkdirSync(DEST, { recursive: true });

  const copied = [];
  for (const name of FILES) {
    if (copyFile(name)) copied.push(name);
  }
  fs.rmSync(path.join(DEST, "lib"), { recursive: true, force: true });
  fs.cpSync(path.join(SOURCE, "lib"), path.join(DEST, "lib"), { recursive: true });

  const nodePath = resolveNodePath();
  fs.writeFileSync(path.join(DEST, "launcher.vbs"), LAUNCHER(nodePath), "utf8");
  const icon = writeIcon(path.join(DEST, "ZCodeSpark.ico"));

  const existed = fs.existsSync(CONFIG_FILE);
  if (!existed) {
    const found = findZcodePath("");
    const config = defaultConfig({ zcodePath: found.path || "" });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf8");
  }
  const config = readJson(CONFIG_FILE) || {};

  let shortcut = "";
  if (!skipShortcut) {
    const lnkPath = path.join(desktopPath(), "ZCode Spark.lnk");
    const ok = createShortcut({
      lnkPath,
      target: "C:\\Windows\\System32\\wscript.exe",
      args: `"${path.join(DEST, "launcher.vbs")}"`,
      workdir: DEST,
      icon: `${icon},0`,
      description: "ZCode Spark — 提示词工作台",
    });
    shortcut = ok ? lnkPath : "（创建失败，可从安装目录双击 launcher.vbs 启动）";
  }

  const lines = [
    `ZCode Spark 已安装到：${DEST}`,
    `node：${nodePath}`,
    `ZCode：${config.zcodePath || "未探测到（请编辑配置里的 zcodePath）"}`,
    `配置：${CONFIG_FILE}${existed ? "（已保留原配置）" : "（首次生成）"}`,
    `日志：${LOG_FILE}`,
    shortcut ? `桌面入口：${shortcut}` : "桌面入口：已跳过（--no-shortcut）",
    `程序文件：${copied.join(", ")} + lib/ + zcode-spark.ico`,
    "",
    "启动方式：双击桌面「ZCode Spark」。原版 ZCode 正在运行时会询问是否关闭重启。",
    "前台调试：在安装目录运行 node controller.mjs（控制台可见日志）。",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

main();
