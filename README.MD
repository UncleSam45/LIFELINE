# LIFELINE

LIFELINE is a browser-based directory and operations console for a Kindroid roster. It keeps the shared roster in a GitHub-hosted bridge configuration, provides profile and family-map editing, and offers tools for creating groups and invoking supported Kindroid API operations.

> [!IMPORTANT]
> LIFELINE is a client-side application. GitHub and Kindroid credentials are sent directly from your browser to their respective APIs. Only use it on a trusted device and review the credential-storage notes below.

## Features

- **GitHub-backed directory** — reads and updates `config.json` in `unclesam45/LIFELINE_BRIDGE`, with fallback support for legacy backup paths.
- **Roster management** — create, search, filter, archive, import, and edit directory profiles.
- **Profile synchronization** — manages Kindroid-facing fields such as name, gender, backstory, memory, directive, additional context, and selected model settings.
- **Family maps** — records parent/child relationships and household notes alongside directory entries.
- **GROUPMAKER** — detects roster members by name, creates or updates Kindroid groups, tracks sessions, and runs presence automations.
- **Kindroid API Studio** — validates and executes registered official and experimental API operations, shows request previews and normalized responses, and supports transcript retrieval.
- **Kindroid web panel** — opens the Kindroid Kins page in a floating, minimizable window that can also dock inside LIFELINE, with a one-click external-tab fallback when Kindroid's embed policy or browser privacy settings block the frame.
- **Responsive interface** — runs as a standalone static page or through the included NiceGUI launcher.

## Requirements

Choose either of these ways to serve the application:

- A modern browser and any local static HTTP server; or
- Python 3.9+ for the NiceGUI launcher (NiceGUI is installed automatically if it is missing).

To use the connected features, you also need:

1. A GitHub access token that can read and write the bridge repository's `config.json` file.
2. A Kindroid API key beginning with `kn_` for Kindroid API and GROUPMAKER actions.

## Quick start

### Option 1: NiceGUI launcher

```bash
git clone <repository-url>
cd LIFELINE
python main.py
```

`main.py` checks for NiceGUI, installs it into the active Python environment when necessary, and opens the app in your browser.

Using a virtual environment is recommended:

```bash
python -m venv .venv
# Linux/macOS
source .venv/bin/activate
# Windows PowerShell
# .venv\Scripts\Activate.ps1
python main.py
```

### Option 2: Static server

Because the frontend is plain HTML, CSS, and JavaScript, it can be served without a build step:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>. Do not open `index.html` through a `file://` URL; browser security restrictions can interfere with module and API requests.

## First-time setup

1. Open LIFELINE and enter the GitHub access token for the bridge repository.
2. Enable **Remember locally** only on a private, trusted device.
3. After the directory loads, open GROUPMAKER or API Studio and enter your Kindroid API key.
4. Confirm the roster before saving. LIFELINE writes changes directly to the bridge configuration.

If the primary bridge file does not yet exist, LIFELINE attempts to load a legacy backup and can migrate that data on the next save.

## Credential storage and privacy

| Credential | Browser storage | Behavior |
| --- | --- | --- |
| GitHub access token | `localStorage` only when **Remember locally** is enabled | Used for GitHub Contents API reads and writes |
| Kindroid API key | `localStorage` after a valid `kn_` key is connected | Used directly in `Authorization` headers sent to Kindroid |

Credentials are not stored in this repository or in `config.json` by the application. Browser storage is readable by scripts running on the same origin, so use a dedicated trusted origin, avoid shared machines, and use the UI's forget/logout controls when finished.

## Project structure

| Path | Purpose |
| --- | --- |
| `index.html` | Minimal static entry page and JavaScript mount point |
| `main.js` | Application UI, state, GitHub bridge integration, and Kindroid tooling |
| `main.py` | NiceGUI bootstrap that serves the current frontend entrypoint |
| `legacy.py` | Earlier desktop implementation retained for reference and migration work |
| `LAUNCHER.bat` | Legacy Windows launcher; it expects an additional `transcribe.py` script that is not included in this repository |

## Development

There is no frontend compilation step. Edit `main.js` or `index.html`, serve the repository, and refresh the browser.

Useful checks before committing:

```bash
python -m py_compile main.py legacy.py
node --check main.js
```

For a lightweight local smoke test:

```bash
python -m http.server 8000
curl --fail http://localhost:8000/
```

API operations affect live remote data. Use test profiles and groups when validating write, rewind, chat-break, or group-management actions.

## Troubleshooting

### GitHub authentication fails

- Confirm the token has access to `unclesam45/LIFELINE_BRIDGE` and permission to read and update repository contents.
- If the token or repository policy changed, forget the saved credential and reconnect.
- A conflict can occur when the bridge file changes elsewhere; reload the current bridge state before retrying.

### Kindroid actions fail

- Confirm the key starts with `kn_` and is active.
- Check the API Studio response category for authentication, permission, rate-limit, network, or server errors.
- Experimental operations can change independently of LIFELINE and may require updates before they work again.

### The Windows batch launcher reports a missing script

`LAUNCHER.bat` belongs to an older two-process workflow and references `transcribe.py`, which is not part of this repository. Run `python main.py` for the current application.

## License

No license file is currently included. Unless the repository owner states otherwise, do not assume permission to redistribute or reuse the code outside the terms under which you received it.
