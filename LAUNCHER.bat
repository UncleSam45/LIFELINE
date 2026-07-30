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

REM main.py is the single launcher. It starts Ollama and the LIFELINE Memory
REM Manager before opening Electron, so every entry point behaves identically.
echo Launching LIFELINE, Memory Manager, and Ollama...
python main.py
set "LIFELINE_EXIT=%ERRORLEVEL%"
if not "%LIFELINE_EXIT%"=="0" (
    echo [ERROR] LIFELINE exited with code %LIFELINE_EXIT%.
    pause
)
exit /b %LIFELINE_EXIT%
