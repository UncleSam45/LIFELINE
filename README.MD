# LIFELINE

LIFELINE is an Electron desktop interface paired with the LIFELINE Memory
Manager. The project uses `main.py` as its single startup entry point so that
the desktop interface, Ollama, and the Memory Manager are started together.

## Requirements

- Python 3.10 or newer
- [Ollama](https://ollama.com/) installed locally
- Internet access on the first launch if Electron or Python dependencies are
  not already installed

Node.js and npm are not required. The launcher uses a locally installed
Electron binary when available and otherwise downloads Electron into
`.lifeline_electron/`.

## Windows setup

Create a virtual environment in the repository and install the Memory Manager
dependencies:

```bat
py -m venv .venv
.venv\Scripts\python.exe -m pip install PySide6 requests jsonschema
```

Then start the complete application with:

```bat
LAUNCHER.bat
```

`LAUNCHER.bat` activates `.venv` (or `venv` as a fallback) and runs
`python main.py`. Do not launch `electron_main.cjs` directly when you want the
complete application stack.

## Direct launch

On Windows, Linux, or macOS, activate the intended Python environment and run:

```bash
python main.py
```

The launcher performs these steps in order:

1. Confirms that the Electron frontend files exist.
2. Starts Ollama, unless its API is already responding at
   `http://127.0.0.1:11434`.
3. Starts `lifeline_memory_manager.py` with the same Python interpreter used to
   run `main.py`.
4. Opens the Electron desktop interface.

Ollama and the Memory Manager are attempted independently. If either companion
cannot start, the launcher prints an error for that service, still attempts the
other service, and continues opening the desktop interface.

## Executable overrides

The launcher normally discovers executables from the active environment and
common installation locations. These environment variables can provide an
explicit executable when automatic discovery is not suitable:

| Variable | Purpose |
| --- | --- |
| `LIFELINE_OLLAMA_BINARY` | Full path to the Ollama CLI or desktop executable |
| `LIFELINE_ELECTRON_BINARY` | Full path to an Electron executable |
| `ELECTRON_BINARY` | Alternate Electron executable override |

Windows example:

```bat
set "LIFELINE_OLLAMA_BINARY=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
LAUNCHER.bat
```

## Startup diagnostics

Background companion output is appended to files under `.lifeline_runtime/`:

- `.lifeline_runtime/ollama.log`
- `.lifeline_runtime/memory-manager.log`

When a companion exits during initial startup, `main.py` reports its exit code,
the relevant log path, and the last available log line. If the desktop window
opens but a companion does not, inspect these logs first.

Common checks:

```bash
# Confirm Ollama's local API is running.
curl http://127.0.0.1:11434/api/tags

# Run the Memory Manager in the foreground to see its complete output.
python lifeline_memory_manager.py

# Run launcher regression tests.
pytest -q test_main.py
```

If Ollama is installed somewhere unusual, set `LIFELINE_OLLAMA_BINARY`. If the
Memory Manager fails with an import error, install `PySide6`, `requests`, and
`jsonschema` into the exact Python environment that runs `main.py`.

## GROUPMAKER auto mode

Auto mode waits five seconds after the last GROUPMAKER field edit, saves the
active session, prepares transcript metadata, and opens or focuses that group's
call window. An existing call window is reused without navigating or reloading
it. Auto mode never closes other group call windows or conversations.

## Memory Manager data

The Memory Manager stores its database and credentials in the
`KINDROIDXL/kindroidxl_data` directory selected by the application. It prefers
the dedicated `D:` drive on Windows, then the current user's Documents folder,
and finally the current user's home directory.

Do not commit `.lifeline_runtime/`, `.lifeline_electron/`, virtual environments,
credentials, or local database files.
