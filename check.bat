@echo off
setlocal
title BlameGoat - Environment Check
cd /d "%~dp0"

rem ---- locate node: PATH first, then fall back to the plain name ----
rem 开发机上的绝对路径不能写死 —— 换台机器就找不到，还会误导别人以为要装到那个位置
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE set "NODE_EXE=node"

echo.
echo  ============== Node runtime ==============
"%NODE_EXE%" -v

echo.
echo  ============== League client (LCU) ==============
"%NODE_EXE%" "%~dp0tools\lcu-selftest.mjs"

echo.
echo  ============== Source self-check ==============
"%NODE_EXE%" "%~dp0tools\check-identifiers.mjs"

echo.
echo  ============== Report perspective ==============
"%NODE_EXE%" "%~dp0tools\check-perspective.mjs"

echo.
echo  ============== Prompt copy sync ==============
"%NODE_EXE%" "%~dp0tools\check-prompt-sync.mjs"

echo  ============== Judging progress ==============
"%NODE_EXE%" "%~dp0tools\check-judge-progress.mjs"

echo.
echo  ============== Local API guard ==============
"%NODE_EXE%" "%~dp0tools\check-api-guard.mjs"

echo.
echo  ============== Update pack chain ==============
"%NODE_EXE%" "%~dp0tools\check-update-pack.mjs"

echo.
echo  ============== DeepSeek endpoint ==============
"%NODE_EXE%" "%~dp0tools\deepseek-check.mjs"

echo.
echo  ============== Summary ==============
echo    A. client installed + running + responsive = ready to read live games
echo    B. endpoint reachable                       = ready for real AI judging
echo    Neither is required to run the UI: start.bat works offline with sample data.
echo.
pause
