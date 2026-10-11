@echo off
REM =========================================================
REM  LOL BeiguoXia - Client Updater
REM
REM  How to use:
REM    1) Drop / drag the update package (*.zip) onto this file, or
REM    2) Run:   update.bat  path\to\update-package.zip
REM
REM  What it does:
REM    Replaces application code only (resources\app).
REM    Your data in data\ (reports / accounts / roster / cache)
REM    is never touched. The previous code is kept as
REM    resources\app.bak-<timestamp> so you can roll back.
REM
REM  Note: this file is intentionally ASCII-only.
REM        Chinese text inside .bat gets mangled by cmd.exe
REM        code pages, so keep messages in English.
REM =========================================================

setlocal enabledelayedexpansion

REM --- locate the client exe (name may contain non-ASCII) ---
set APP_EXE=
for %%f in ("%~dp0*.exe") do (
  echo %%~nxf | findstr /I /V /C:"notification_helper" >nul
  if not errorlevel 1 (
    if not exist "%%f:Zone.Identifier" (
      if "!APP_EXE!"=="" set APP_EXE=%%f
    )
  )
)

if "%~1"=="" (
  echo.
  echo   No update package given.
  echo   Drag the update zip onto this file, or run:
  echo       update.bat  path\to\update-package.zip
  echo.
  pause
  exit /b 1
)

if not exist "%~1" (
  echo.
  echo   [X] Update package not found: %~1
  echo.
  pause
  exit /b 1
)

REM --- Is this file sitting INSIDE an installation? ---
set INSTALL=%~dp0
set IN_APP=%~dp0resources\app\desktop\apply-update.mjs
if not exist "%IN_APP%" set IN_APP=%~dp0apply-update.mjs

if not exist "%IN_APP%" (
  echo.
  echo   [X] Updater script not found next to update.bat.
  echo       Expected: resources\app\desktop\apply-update.mjs
  echo.
  pause
  exit /b 1
)

REM No client exe here => we are running from an extracted update package.
REM Ask once which folder to upgrade (first-time users coming from an
REM installation that predates the updater).
REM
REM NOTE: this block must NOT be written as `if ... ( ... )`. A literal "("
REM inside a parenthesised block (even inside a "set /p" prompt) closes the
REM block early, and cmd then fails the WHOLE batch at parse time with
REM "was unexpected at this time" -- no output, window just flashes by.
REM Use goto so the prompt stays at top level.
if not "!APP_EXE!"=="" goto :have-exe

echo.
echo   No client installation detected next to this file.
echo   Looks like you opened update.bat from the extracted update package.
echo.
REM Clear it first: "set /p" with empty input leaves the old value in place.
set INSTALL=
set /p "INSTALL=Paste the client folder to upgrade: "
echo.

:have-exe

if "!INSTALL!"=="" (
  echo.
  echo   [X] No target folder given.
  echo.
  pause
  exit /b 1
)

REM Strip surrounding quotes the user may have pasted
set INSTALL=!INSTALL:"=!
REM Trailing backslash would escape the closing quote -> strip it
if "!INSTALL:~-1!"=="\" set INSTALL=!INSTALL:~0,-1!

if not exist "!INSTALL!\resources" (
  echo.
  echo   [X] Not a client folder: !INSTALL!
  echo.
  pause
  exit /b 1
)

REM Find the exe inside the chosen installation
for %%f in ("!INSTALL!\*.exe") do (
  echo %%~nxf | findstr /I /V /C:"notification_helper" >nul
  if not errorlevel 1 if "!APP_EXE!"=="" set APP_EXE=%%f
)

if "!APP_EXE!"=="" (
  echo.
  echo   [X] No client exe found in: !INSTALL!
  echo.
  pause
  exit /b 1
)

REM Electron behaves as plain Node when ELECTRON_RUN_AS_NODE is set,
REM so no separate Node install is needed on the target machine.
set ELECTRON_RUN_AS_NODE=1
"!APP_EXE!" "%IN_APP%" "%~1" --root "!INSTALL!"
set RC=!errorlevel!

echo.
echo   Exit code: !RC!
echo.
pause
exit /b !RC!
