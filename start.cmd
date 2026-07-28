@echo off
chcp 65001 >nul
title HoMix - 本地视频智能混剪
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js。请先安装 Node.js 20 或更高版本。
  echo https://nodejs.org/
  pause
  exit /b 1
)
echo 正在启动 HoMix...
node server.js
if errorlevel 1 pause
