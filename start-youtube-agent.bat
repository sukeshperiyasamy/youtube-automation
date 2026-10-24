@echo off
title YouTube Automation Agent Dashboard
cd /d "D:\comfyui\sukesh\youtube-automation-agent"

set "PATH=C:\Program Files\nodejs;C:\Users\Indraes Ravikumar\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin;%PATH%"

echo ========================================================
echo Starting YouTube Automation Agent...
echo Workspace: D:\comfyui\sukesh\youtube-automation-agent
echo Dashboard: http://127.0.0.1:3456
echo ========================================================
echo.

node index.js

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] YouTube Automation Agent stopped with error code %ERRORLEVEL%.
    echo Press any key to close this window...
    pause >nul
)