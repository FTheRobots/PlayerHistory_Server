@echo off
setlocal
cd /d "%~dp0"

echo Installing dependencies...
if not exist node_modules call npm install
if errorlevel 1 exit /b 1

echo Building TypeScript...
call npm run build
if errorlevel 1 exit /b 1

echo Packaging portable server exe...
call npm run pack
if errorlevel 1 exit /b 1

if not exist release mkdir release
copy /Y config.example.json release\config.example.json >nul

echo.
echo Done. Portable server:
dir /b release\PlayerHistory-Server.*.exe 2>nul
echo.
echo Copy config.example.json to config.json beside the exe and set playerHistoryPath.
endlocal
