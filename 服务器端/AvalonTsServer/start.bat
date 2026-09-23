@echo off
setlocal
cd /d "%~dp0"
set "npm_config_cache=%CD%\.npm-cache"
if not exist node_modules (
    echo Installing Avalon TypeScript server dependencies...
    call npm install
    if errorlevel 1 exit /b %errorlevel%
)
call npm run dev
