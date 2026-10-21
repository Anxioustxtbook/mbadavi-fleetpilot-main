@echo off
REM Starts a tiny local web server for the built app and opens it in the browser.
REM Keep PORT the same every time so your saved data stays in the same browser storage.
set PORT=4173
cd /d "%~dp0app"
where python >nul 2>nul && goto usepython
where py >nul 2>nul && goto usepy
where npx >nul 2>nul && goto usenpx
echo Need Python or Node.js on this PC to run the app. Install one of them and try again.
pause & exit /b 1

:usepython
start "" http://localhost:%PORT%
python -m http.server %PORT%
goto :eof

:usepy
start "" http://localhost:%PORT%
py -m http.server %PORT%
goto :eof

:usenpx
start "" http://localhost:%PORT%
npx --yes serve -l %PORT% .
goto :eof
