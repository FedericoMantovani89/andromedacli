@echo off
rem Starts AndromedaConsole. Usage: start-console.bat [project folder]
rem Without an argument the console opens the projects it remembers, or asks which project to work on (a folder window).
rem With a folder it opens that project first.
setlocal
cd /d "%~dp0"

set "PLAN_ROOT=%~1"
if not "%PLAN_ROOT%"=="" if not exist "%PLAN_ROOT%\" (
  echo The folder "%PLAN_ROOT%" does not exist.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm ci || goto :failed
)
if not exist dist\ui\app.js (
  echo Building the interface...
  call npm run build || goto :failed
)

echo Starting the console...
if "%PLAN_ROOT%"=="" (
  call npm run console -- serve
) else (
  call npm run console -- serve --project-root "%PLAN_ROOT%"
)
echo.
echo The console stopped.
pause
exit /b 0

:failed
echo.
echo Something failed above.
pause
exit /b 1
