@echo off
cd /d "%~dp0"
set "PH_APP_ROOT=%~dp0"
if "%PH_APP_ROOT:~-1%"=="\" set "PH_APP_ROOT=%PH_APP_ROOT:~0,-1%"

set "PH_SERVER_EXE="
for /f "delims=" %%F in ('dir /b /a:-d "PlayerHistory-Server.*.exe" 2^>nul') do (
  set "PH_SERVER_EXE=%%F"
  goto :found
)

echo PlayerHistory-Server.{version}-{Codename}.exe not found beside this launcher.
pause
exit /b 1

:found
"%PH_APP_ROOT%\%PH_SERVER_EXE%" %*
