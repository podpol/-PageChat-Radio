@echo off
chcp 65001 >nul
title PageChat Radio Pro — Server

color 0A

echo.
echo   ============================================================
echo.
echo     PageChat Radio Pro
echo     Signaling Server (by yayaya)
echo.
echo   ============================================================
echo.

:: Check Node.js
node --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo   [ERROR] Node.js is not installed.
    echo   Download: https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: Check dependencies
if not exist "node_modules\" (
    echo   [INFO] Installing dependencies...
    echo.
    call npm install
    echo.
)

:: Show local IPs
echo   ------------------------------------------------------------
echo   Local network URLs (share with others on your network):
echo   ------------------------------------------------------------
echo.
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /C:"IPv4"') do (
    for /f "tokens=1" %%b in ("%%a") do (
        echo     ws://%%b:3000
    )
)
echo.
echo   Internet URL (if port 3000 is forwarded):
echo     ws://YOUR_PUBLIC_IP:3000
echo.
echo   Status page:
echo     http://localhost:3000
echo.
echo   ============================================================
echo   Server starting...
echo   Press Ctrl+C to stop.
echo   ============================================================
echo.

:: Start server
node server.js

:: If server crashed
echo.
echo   ============================================================
echo   Server stopped unexpectedly.
echo   ============================================================
echo.
pause