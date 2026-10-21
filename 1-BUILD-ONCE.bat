@echo off
REM Run this ONCE, inside the unzipped mbadavi-fleetpilot-main folder (needs Node.js installed + internet).
cd /d "%~dp0"
if not exist package.json (
  echo Put this file inside the mbadavi-fleetpilot-main folder, next to package.json, then run it again.
  pause & exit /b 1
)
call npm install
if errorlevel 1 (echo npm install failed & pause & exit /b 1)
call npm run build
if errorlevel 1 (echo build failed & pause & exit /b 1)
if exist "Fleetpilot-Portable" rmdir /s /q "Fleetpilot-Portable"
mkdir "Fleetpilot-Portable"
xcopy /e /i /q dist "Fleetpilot-Portable\app" >nul
copy /y "%~dp02-RUN-FLEETPILOT.bat" "Fleetpilot-Portable\" >nul
echo.
echo Done. Copy the "Fleetpilot-Portable" folder to your flash disk.
pause
