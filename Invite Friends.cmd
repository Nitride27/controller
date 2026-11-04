@echo off
if not exist "%~dp0server\.venv\Scripts\python.exe" (
  echo Open Phone Pad first, then try this again.
  pause
  exit /b 1
)
"%~dp0server\.venv\Scripts\python.exe" "%~dp0server\invite.py"
if errorlevel 1 pause
