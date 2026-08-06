# LIFELINE Kindroid transcript userscript

## KINDROID XL site layer

`KINDROIDXL.js` is a standalone Tampermonkey userscript loaded across the entire
Kindroid website. Its first enhancement adds **KINDROID XL · GitHub** to Kindroid's
`/v2/settings/` page. Open the entry to provide a GitHub username, repository,
and fine-grained personal access token, then select **Test connection**. A
successful GitHub REST API response saves the username and repository and shows
an animated confirmation.

The token is saved in Tampermonkey storage only when **Remember token on this
device** is selected. Leaving it unselected removes any previously remembered
token after the connection succeeds. The token is sent only to
`https://api.github.com/repos/<username>/<repository>` and is never added to the
Kindroid page's storage. To install the layer, create a new Tampermonkey script,
replace its template with the complete contents of `KINDROIDXL.js`, and save it.

## Call message toolkit

`lifeline-kindroid-call-toolkit.user.js` is the single, standalone call-page toolkit used by both Electron and Tampermonkey. On Kindroid call pages it mounts a large, collapsible quick-reply panel at the middle-left of the screen. Its starter replies can be sent with one click. The large text field sends on Enter (use Shift+Enter for a new line) and automatically encloses every on-the-fly message in asterisks. Open the gear menu to add, edit, or delete presets; changes are saved in browser storage and remain available after reloads. Preset messages continue to be sent exactly as saved.

The green **SPEAKER MONITOR** control at the bottom left is enabled by default and immediately watches Kindroid's active-speaker tile. If the same detected speaker remains active for two minutes, the toolkit sends `*CONTINUES CONVERSATION*` and immediately starts a fresh two-minute interval even when the active speaker does not change. Click the control to stop monitoring; click it again to resume.

For Tampermonkey, create a new script and paste the complete contents of `lifeline-kindroid-call-toolkit.user.js`, or install that raw file directly. It has no external `@require`; the metadata and complete implementation live in the same valid userscript file.

## Transcript bridge

`lifeline-kindroid-transcript.user.js` brings the Electron group-call transcript bridge to normal browsers through Tampermonkey.

GROUPMAKER initializes `transcripts/<group-id>/transcript.json` with its participant names when a group is created or updated. If a transcript already has an empty participant list, the userscript recovers the matching names from `config.json` before saving. It only detects speaker names from the Kindroid DOM when neither source contains GROUPMAKER metadata. Captures append transcript text without replacing authoritative participants.

The frontend does not navigate the prepared browser/Electron tab to Kindroid until both `config.json` and the transcript participant metadata have been written successfully. This prevents automatic userscript capture from winning a race and creating an empty participant list first.

## Install

1. Install Tampermonkey in the browser.
2. Open the Tampermonkey dashboard, choose **Create a new script**, replace the template with the full contents of `lifeline-kindroid-transcript.user.js`, and save it.
3. In GitHub, create a fine-grained personal access token scoped only to the `unclesam45/LIFELINE_BRIDGE` repository. Grant **Contents: Read and write**; no broader account permission is needed.
4. Open any Kindroid group call URL (`https://kindroid.ai/v2/call/group/<group-id>/`). Enter the token in the floating **LIFELINE TRANSCRIPT** panel and select **Capture now**. Select **Remember in Tampermonkey** only on a trusted device.

After a token is entered, the script retries capture every three seconds until the transcript is available and then synchronizes once per minute. It opens Kindroid's Transcript panel, extracts only transcript-row text, preserves the Electron bridge's version 2 JSON shape, merges overlapping rows, and writes `transcripts/<group-id>/transcript.json` on the bridge's `main` branch. GitHub SHA conflicts—including the `does not match <sha>` response—cause cache-bypassing reads and up to four fresh merge attempts, so simultaneous captures retain one another's entries instead of repeatedly failing against an obsolete revision.

The extractor recognizes both legacy Kindroid menus and the current `aria-label="Call menu"` dialog trigger. When transcript rows are unavailable it can retry opening the call menu on a later capture, selects the exact `Transcript` row (including the current `call-dock-v2_menu-row` button), and avoids toggling an option whose `aria-pressed` state already says the panel is open.

## Security and troubleshooting

- The token is passed only to `https://api.github.com`. Tampermonkey's cross-origin request grant avoids page CORS restrictions.
- A remembered token lives in Tampermonkey extension storage. Use **Forget token** after capture on a shared computer.
- A 401 or 403 response normally means the token is expired, targets the wrong repository, or lacks **Contents: Read and write**.
- The userscript is loaded on the wider `/v2/call/*` URL family so it survives Kindroid client-side navigation, but repository writes are deliberately restricted to `/v2/call/group/<group-id>/` pages to retain the Electron bridge's group transcript layout.
