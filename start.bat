@echo off
title Priv-App Module Generator
color 0B

echo ===================================================
echo       Priv-App Module Generator Startup Script
echo ===================================================
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [!] Node.js is not installed or not in system PATH.
    echo Please install Node.js (v18+) from https://nodejs.org/
    pause
    exit /b 1
)

:: Check for node_modules folder to determine if it's the first run
if not exist "node_modules\" (
    echo [*] First run detected! Installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [!] npm install failed. Please check your Node.js installation.
        pause
        exit /b 1
    )
    echo [*] Dependencies installed successfully!
    echo.
) else (
    echo [*] Dependencies found. Skipping npm install...
)

echo [*] Starting the local server...
echo [*] Opening browser at http://localhost:3000...

:: Trick to wait a couple of seconds for the server to spin up, then open browser
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"

:: Start the server in the current window
node server.js

pause
