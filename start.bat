@echo off
setlocal
title BlameGoat - LOL Blame Report
cd /d "%~dp0"

rem ---- locate node: PATH first, then fall back to the plain name ----
rem 开发机上的绝对路径不能写死 —— 换台机器就找不到，还会误导别人以为要装到那个位置
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE set "NODE_EXE=node"

echo.
echo  ==================================================
echo    BlameGoat   LOL Blame Report
echo  ==================================================
echo    node    %NODE_EXE%
echo    url     http://127.0.0.1:7710
echo  ==================================================
echo.

rem  pass through args ( --no-open skips auto browser launch )
"%NODE_EXE%" "%~dp0server\server.mjs" %*
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo  [!] server exited with code %RC%
  echo  [!] if the port is busy, run:  set PORT=7711 ^&^& start.bat
)
echo  BlameGoat stopped.
pause
