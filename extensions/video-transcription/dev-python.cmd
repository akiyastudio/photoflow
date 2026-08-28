@echo off
setlocal
if defined PHOTOFLOW_TRANSCRIPTION_PYTHON (
  "%PHOTOFLOW_TRANSCRIPTION_PYTHON%" %*
  exit /b %errorlevel%
)
if exist "C:\dev\app3\.venv\Scripts\python.exe" (
  "C:\dev\app3\.venv\Scripts\python.exe" %*
  exit /b %errorlevel%
)
py -3 %*
