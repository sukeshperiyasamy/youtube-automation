@echo off
title YouTube Authorization
cd /d "D:\comfyui\sukesh\youtube-automation-agent"

set "PATH=C:\Program Files\nodejs;C:\Users\Indraes Ravikumar\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin;%PATH%"

echo ========================================================
echo Starting YouTube Authorization...
echo A browser window will open for Google sign-in.
echo ========================================================
echo.

node modern-auth.js

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Authorization process exited with code %ERRORLEVEL%.
    echo Press any key to close this window...
    pause >nul
)