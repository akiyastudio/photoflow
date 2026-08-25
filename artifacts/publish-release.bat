@echo off
setlocal
chcp 65001 >nul
set "REPOSITORY_ROOT=%~dp0.."
cd /d "%REPOSITORY_ROOT%"
node "%REPOSITORY_ROOT%\scripts\publish-release.cjs" %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" echo 发布失败，请查看上面的错误信息。
pause
endlocal & exit /b %EXIT_CODE%
