@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

set SNET_WRAPPED=1

REM ============================================
REM  snet — GitHub Copilot to OpenCode
REM ============================================

:restart
cls

REM 1. Load .env
if exist .env (
    for /f "usebackq delims=" %%x in (".env") do (
        set "line=%%x"
        if not "!line:~0,1!"=="#" set "%%x"
    )
)

if "%SERVER_PORT%"=="" set SERVER_PORT=11434

REM 2. Kill any existing snet instance by window title, then clean port
echo [INFO] Stopping any existing snet instance...
taskkill /fi "WINDOWTITLE eq snet" /f >nul 2>&1
title Snet
REM Wait briefly for process to die
timeout /t 1 /nobreak >nul
REM Port Cleanup with retry (matching service.exe 4x1s behavior)
for /l %%i in (1,1,4) do (
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%SERVER_PORT% " ^| findstr "LISTENING" 2^>nul') do (
        taskkill /pid %%a /f >nul 2>&1
    )
    REM Check if port is free
    netstat -ano | findstr ":%SERVER_PORT% " | findstr "LISTENING" >nul 2>&1
    if errorlevel 1 goto :port_free
    timeout /t 1 /nobreak >nul
)
:port_free

REM 3. Set libuv thread pool size for DNS/file I/O concurrency
if "%UV_THREADPOOL_SIZE%"=="" set UV_THREADPOOL_SIZE=8

REM 4. Try Bun first
where bun >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [INFO] Runtime: Bun
    if not exist node_modules (
        echo [INFO] Installing dependencies...
        call bun install
    )
    echo.
    bun --smol run src/server.js %*
    if !ERRORLEVEL! equ 43 (
        echo [UPDATE] Running updater...
        call "%~dp0update.cmd"
        goto :restart
    )
    if !ERRORLEVEL! equ 42 goto :restart
    goto :EOF
)

REM 5. Fallback to Node.js
where node >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [INFO] Runtime: Node.js
    if not exist node_modules\.package-lock.json (
        echo [INFO] Installing dependencies...
        call npm install hono undici --no-bin-links >nul 2>&1
    )
    echo.
    REM --expose-gc enables manual gc; --max-old-space-size limits heap to avoid runaway memory
    node --expose-gc --max-old-space-size=4096 src/server.js %*
    if !ERRORLEVEL! equ 43 (
        echo [UPDATE] Running updater...
        call "%~dp0update.cmd"
        goto :restart
    )
    if !ERRORLEVEL! equ 42 goto :restart
    goto :EOF
)

REM 6. Neither found
echo [ERROR] Neither Bun nor Node.js found in PATH.
echo        Install Bun: https://bun.sh
echo        Install Node: https://nodejs.org
pause
