@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
node "%~dp0scripts\generate-release-json.cjs" %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" echo Script failed. See the error above.
if "%~1"=="" pause
endlocal & exit /b %EXIT_CODE%
