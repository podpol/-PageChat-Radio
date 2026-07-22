@echo off
chcp 65001 >nul
title PageChat Radio Pro — Setup
color 0A

echo.
echo   ============================================================
echo.
echo     PageChat Radio Pro
echo     First-Time Setup
echo.
echo   ============================================================
echo.

:: ── Step 1: Check Node.js ──
echo   [1/3] Checking Node.js...
node --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo   [ERROR] Node.js is not installed.
    echo.
    echo   Download LTS version:
    echo   https://nodejs.org
    echo.
    echo   Install it, then run this script again.
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do set NODE_VER=%%i
echo         OK — Node.js %NODE_VER%

:: ── Step 2: Install dependencies ──
echo.
echo   [2/3] Installing dependencies...
if not exist "node_modules\" (
    call npm install
    if %ERRORLEVEL% NEQ 0 (
        echo.
        echo   [ERROR] Installation failed. Check your internet connection.
        echo.
        pause
        exit /b 1
    )
)
echo         OK — Dependencies installed

:: ── Step 3: Firewall (optional) ──
echo.
echo   [3/3] Configuring firewall...
net session >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo         SKIPPED — Run as Administrator to open ports.
    echo         You can run firewall.bat separately later.
) else (
    netsh advfirewall firewall delete rule name="PageChat Radio Server" >nul 2>&1
    netsh advfirewall firewall delete rule name="PageChat Radio Server UDP" >nul 2>&1
    netsh advfirewall firewall add rule name="PageChat Radio Server" dir=in action=allow protocol=TCP localport=3000 >nul 2>&1
    netsh advfirewall firewall add rule name="PageChat Radio Server UDP" dir=in action=allow protocol=UDP localport=10000-60000 >nul 2>&1
    echo         OK — Ports 3000 (TCP) and 10000-60000 (UDP) opened
)

:: ── Done ──
echo.
echo   ============================================================
echo.
echo   Setup complete.
echo.
echo   Next step: run start.bat to launch the server.
echo.
echo   ============================================================
echo.
pause