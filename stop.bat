@echo off
chcp 65001 >nul
title PageChat Radio Pro — Stop Server
color 0A

echo.
echo   ============================================================
echo.
echo     PageChat Radio Pro
echo     Stopping Server...
echo.
echo   ============================================================
echo.

taskkill /F /IM node.exe /FI "WINDOWTITLE eq PageChat Radio Pro — Server" >nul 2>&1

if %ERRORLEVEL% EQU 0 (
    echo   Server stopped successfully.
) else (
    echo   No running server found.
)

echo.
timeout /t 2 >nul