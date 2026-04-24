@echo off
echo ========================================
echo  TonesinTime - Windows Build
echo ========================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed.
    echo Download it from https://nodejs.org
    pause
    exit /b 1
)

echo Installing dependencies...
call npm install

echo.
echo Building Windows portable exe...
call npx electron-builder --win --config.win.target=portable

echo.
echo ========================================
echo  BUILD COMPLETE
echo  Your .exe is in the dist/ folder
echo ========================================
pause
