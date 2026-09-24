@echo off
cd /d "%~dp0..\..\服务器端\AvalonTsServer"
call npm run build
if errorlevel 1 exit /b 1
call npm start
