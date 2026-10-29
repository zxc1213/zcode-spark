@echo off
rem 前台调试入口：控制台可见日志，Ctrl+C 退出
cd /d "%~dp0"
node controller.mjs %*
pause
