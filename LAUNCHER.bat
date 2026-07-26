@echo off
setlocal

REM Always run from this batch file's folder
cd /d "%~dp0"

REM Activate local virtual environment (.venv preferred, then venv)
if exist ".venv\Scripts\activate.bat" (
    call ".venv\Scripts\activate.bat"
) else if exist "venv\Scripts\activate.bat" (
    call "venv\Scripts\activate.bat"
) else (
    echo [ERROR] No virtual environment activation script was found.
    echo Expected: .venv\Scripts\activate.bat or venv\Scripts\activate.bat
    pause
    exit /b 1
)

REM Launch both scripts in separate windows so transcribe starts even if main.py keeps running
echo Launching main.py...
start "MEDIATOR Main" python main.py
if not "%ERRORLEVEL%"=="0" (
    echo [ERROR] Failed to launch main.py.
    pause
    exit /b %ERRORLEVEL%
)

echo Launching transcribe.py...
start "MEDIATOR Transcribe" python transcribe.py
if not "%ERRORLEVEL%"=="0" (
    echo [ERROR] Failed to launch transcribe.py.
    pause
    exit /b %ERRORLEVEL%
)

exit /b 0
