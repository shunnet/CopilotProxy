@echo off
setlocal enabledelayedexpansion

echo ================================================
echo  snet -- Build
echo ================================================
echo.

REM -- Clean previous build
if not exist .dist mkdir .dist
for /d %%i in (.dist\*) do rmdir /s /q "%%i" 2>nul
for %%i in (.dist\*) do (
    set "_f=%%~nxi"
    if "!_f:~0,1!" neq "." del /q "%%i" 2>nul
)

REM -- Clean leftover bun build artifacts
for /r %%i in (*.bun-build) do del /q "%%i" 2>nul

REM -- Detect Bun
bun --version >nul 2>&1
if !ERRORLEVEL! equ 0 (
    endlocal
    call "%~dp0build-bun.cmd"
    exit /b
)

REM -- Fallback to Node.js
node --version >nul 2>&1
if !ERRORLEVEL! equ 0 (
    endlocal
    call "%~dp0build-node.cmd"
    exit /b
)

REM -- Neither found
echo [ERROR] Neither Bun nor Node.js found.
echo        Install Bun:  https://bun.sh
echo        Install Node: https://nodejs.org
endlocal
exit /b 1
