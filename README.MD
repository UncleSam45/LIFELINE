# LIFELINE

> **Pre-alpha prototype:** LIFELINE is experimental, incomplete, and under active development. It is not production-ready. Features, data formats, setup steps, and integrations may change or break without notice. Use it only for testing and prototyping, and keep backups of any important data.

LIFELINE is a desktop prototype for organizing Kindroid-related directory data, group sessions, transcripts, journals, automations, and local long-term memory. An Electron interface works with a Python Memory Manager and a local Ollama service. `main.py` starts the complete stack.

## Current components

- **Desktop interface:** directory, GROUPMAKER, Kindroid panel, wiki, and automation views.
- **Memory Manager:** processes transcript bridge data and stores local memory records.
- **Ollama integration:** supplies local model inference for memory workflows.
- **Userscripts:** optional Kindroid transcript, call, journal, and site helpers.

These components are prototypes and should be expected to change.

## Requirements

- Python 3.10 or newer
- [Ollama](https://ollama.com/) installed locally
- Internet access when Electron or Python dependencies must be downloaded

Node.js and npm are not required. The launcher uses an installed Electron binary when available or downloads one into `.lifeline_electron/`.

## Setup and launch

Create a virtual environment and install the Python dependencies:

```bash
python -m venv .venv
.venv/bin/python -m pip install PySide6 requests jsonschema
```

On Windows, install with:

```bat
.venv\Scripts\python.exe -m pip install PySide6 requests jsonschema
```

Activate the environment, then run:

```bash
python main.py
```

On Windows, `LAUNCHER.bat` activates `.venv` or `venv` and runs the same launcher:

```bat
LAUNCHER.bat
```

The launcher starts Ollama when needed, starts `lifeline_memory_manager.py`, and opens the Electron interface. Do not start `electron_main.cjs` directly when you need the complete stack.

## Optional executable overrides

| Variable | Purpose |
| --- | --- |
| `LIFELINE_OLLAMA_BINARY` | Path to the Ollama CLI or desktop executable |
| `LIFELINE_ELECTRON_BINARY` | Path to an Electron executable |
| `ELECTRON_BINARY` | Alternate Electron executable override |

## Runtime data

Launcher logs are written to `.lifeline_runtime/`. The Memory Manager stores its database and credentials in the selected `KINDROIDXL/kindroidxl_data` directory.

Do not commit runtime logs, downloaded Electron files, virtual environments, credentials, or local databases. Back up prototype data before upgrades because compatibility is not guaranteed during pre-alpha development.
