@echo off
setlocal enabledelayedexpansion
rem =====================================================================
rem  LOL Beigouxia (BlameGoat) - desktop client installer
rem  No admin rights required. It only copies files + makes a shortcut.
rem
rem  Usage:
rem    install.bat                      install to %%LOCALAPPDATA%%\Programs\LOL Beigouxia
rem    install.bat --dir=D:\MyApp       install somewhere else
rem    install.bat --no-data            do not migrate existing match data
rem =====================================================================
title LOL Beigouxia - Install

set "HERE=%~dp0"
set "SCRIPT=%HERE%install.mjs"
if not exist "%SCRIPT%" set "SCRIPT=%HERE%tools\install.mjs"
if not exist "%SCRIPT%" (
  echo [ERROR] install.mjs not found next to this bat.
  echo.
  pause
  exit /b 1
)

rem ---------- 1) look for a node runtime ----------
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do (
  if not defined NODE set "NODE=%%i"
)
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"

rem ---------- 2) fallback: let the packaged exe act as node ----------
set "EXEASNODE="
if not defined NODE (
  for /d %%d in ("%HERE%*") do (
    if exist "%%~d\resources\app" (
      for %%f in ("%%~d\*.exe") do set "EXEASNODE=%%~f"
    )
  )
)
if not defined NODE if not defined EXEASNODE (
  for %%f in ("%HERE%*.exe") do set "EXEASNODE=%%~f"
)

if defined NODE (
  echo Runtime: !NODE!
  "!NODE!" "%SCRIPT%" %*
  goto :done
)
if defined EXEASNODE (
  echo Runtime: bundled client (no Node needed)
  set ELECTRON_RUN_AS_NODE=1
  "!EXEASNODE!" "%SCRIPT%" %*
  goto :done
)

echo [ERROR] No node runtime found and no packaged client next to this bat.
echo         Put this bat inside the client folder, or install Node.js.
echo.
pause
exit /b 1

:done
if errorlevel 1 (
  echo.
  echo [FAILED] Install did not finish. See messages above.
  pause
  exit /b 1
)
echo.
echo Done. You can close this window.
pause
exit /b 0
