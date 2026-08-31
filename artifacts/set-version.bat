@echo off
setlocal
chcp 65001 >nul
set "REPOSITORY_ROOT=%~dp0.."
cd /d "%REPOSITORY_ROOT%"
node "%REPOSITORY_ROOT%\scripts\manage-release-versions.cjs" %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" echo 版本更新或打包失败，请查看上面的错误信息。
if "%~1"=="" pause
endlocal & exit /b %EXIT_CODE%
