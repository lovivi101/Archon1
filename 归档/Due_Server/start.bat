@echo off
set "CONFIG_PATH=D:\hong_work\game\avalon\server\config\default.toml"
echo Starting Avalon Game Servers...

start "Avalon Gate" cmd /k "go run D:\hong_work\game\avalon\server\gate\main.go"
timeout /t 2
start "Avalon Node" cmd /k "go run D:\hong_work\game\avalon\server\node\main.go"

echo Servers are starting in separate windows.
pause
