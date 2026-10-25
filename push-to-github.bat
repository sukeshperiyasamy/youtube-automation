@echo off
title Push YouTube Automation Agent to GitHub
cd /d "D:\comfyui\sukesh\youtube-automation-agent"
echo ========================================================
echo  Pushing YouTube Automation Agent to your GitHub:
echo  Remote: https://github.com/sukeshperiyasamy/youtube-automation.git
echo ========================================================
echo.
echo If a browser window opens, please sign in to your GitHub account
echo and authorize Git Credential Manager to complete the push.
echo.
git push -u origin main
echo.
if %ERRORLEVEL% equ 0 (
    echo [SUCCESS] Successfully pushed all workflows and code to GitHub!
    echo Visit: https://github.com/sukeshperiyasamy/youtube-automation
) else (
    echo [ERROR] Push failed or was cancelled.
    echo Please make sure you are logged into your GitHub account: sukeshperiyasamy
)
echo.
pause
