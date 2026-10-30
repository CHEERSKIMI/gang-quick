@echo off
rem gang-quick 一键启动（Windows）
rem 需要：Node 18+、baw 已登录（baw auth signin）
setlocal
cd /d "%~dp0"
if not defined PORT set "PORT=8790"
echo [gang-quick] 启动中 -> http://127.0.0.1:%PORT%
echo [gang-quick] 关掉这个窗口即停止
node server.mjs
if errorlevel 1 (
  echo.
  echo [gang-quick] 进程退出，错误码 %errorlevel%
  pause
)
