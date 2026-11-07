# BridgeBox desktop collector

A small Node 20+ program for Windows and macOS that records **which application is in front, for how long, and a coarse category of the document** — nothing else — and sends it to your BridgeBox server during an authorized observation campaign.

## What it never does

There are no input hooks, no screen capture and no network sniffing in this program or its dependencies. It **never** records keystrokes, clipboard contents, screenshots, URLs, window titles, file names, or the contents of emails, chats or documents. The window title is read only to derive a coarse category (`invoice`, `report`, `ticket`, …) and a salted one-way hash on the employee's machine; the raw title is discarded in memory and never written to disk or sent. Apps on the blocked list (password managers, banking, health, personal messaging, plus whatever the organization adds) are never sampled at all. The server rejects any payload field that could carry content (`src/collector-protocol/schema.ts`).

## Install & enroll

An admin creates a one-time enrollment code on **Data Collection → Collectors → Create enrollment code**. The code is valid for 7 days and one use.

```sh
# macOS / Linux
BRIDGEBOX_URL=https://app.example.com BRIDGEBOX_ENROLL_CODE=BB-XXXXXXXXXXXX bridgebox-collector
# Windows PowerShell
$env:BRIDGEBOX_URL="https://app.example.com"; $env:BRIDGEBOX_ENROLL_CODE="BB-XXXXXXXXXXXX"; bridgebox-collector.exe
```

On first run the collector prints the organization's employee notice and asks `y/N`. Nothing is recorded until the employee answers `y` (this is written to the server as their consent record). Managed installs may pass `--accept-notice` **only** when the notice has already been delivered and acknowledged through HR; the acknowledgement is still recorded against the employee.

Flags: `--url`, `--enroll-code`, `--data-dir`, `--accept-notice`, `--simulate [events.json]`, `--once`, `--quiet`.
Env: `BRIDGEBOX_URL`, `BRIDGEBOX_ENROLL_CODE`, `BRIDGEBOX_DATA_DIR`, `BRIDGEBOX_QUIET=1`.

### Data directory

| OS | Path |
|---|---|
| Windows | `%LOCALAPPDATA%\BridgeBoxCollector\` |
| macOS | `~/Library/Application Support/BridgeBoxCollector/` |
| Linux | `~/.local/share/bridgebox-collector/` |

Files: `collector.json` (server URL, collector id, token, per-machine hash salt, accepted notice version — mode 600), `queue.jsonl` (unsent events, bounded at 200k), `status.json`, `control.json` (pause/resume commands).

## Employee controls

```sh
bridgebox-collector pause 30     # pause for 30 minutes (default 60); recorded on the server and audited
bridgebox-collector resume
bridgebox-collector status
bridgebox-collector stop
```
On macOS/Linux `SIGUSR1` pauses for 60 min and `SIGUSR2` resumes. Employees can also pause or withdraw consent from **Trust & Privacy** in the web app; the server then drops anything the collector sends.

## Behaviour

- Samples the foreground window every `sampleIntervalMs` (default 2 s) with [`active-win`](https://github.com/sindresorhus/active-win); only inside the campaign's days/hours (outside the window it sleeps and samples nothing).
- Emits `app_switch`, `app_focus` (with duration), `document_open` (title category changed inside a document-type app), `idle_start` / `idle_end`.
- Idle: uses `desktop-idle` if it happens to be installed; otherwise "no foreground change for `idleThresholdSec`" (default 180 s). We do not install input hooks to detect idle precisely.
- Batches to `POST /api/collect/events` every `batchIntervalMs` (default 30 s, max 5000 events/batch) from a disk-backed queue with exponential backoff (30 s → 15 min). Heartbeat every 60 s. Config refresh every 5 min. Graceful shutdown flushes the open segment and sends a final heartbeat.
- Honours server config: `blockedApps`, `titleMode` (`hash` | `category` | `none`), `schedule`, intervals. The server enforces all of these again regardless.
- If the server reports the collector as revoked or the token is rejected, the collector stops and says so.

## Build & package

```sh
cd collector
npm install            # active-win (native, Windows/macOS), zod; desktop-idle optional
npm run build          # tsc -> dist/collector/src/index.js
# Single-file binaries (requires @yao-pkg/pkg, not installed by default):
npm i -g @yao-pkg/pkg
npm run package:win    # release/bridgebox-collector.exe
npm run package:mac    # release/bridgebox-collector (arm64 + x64)
```
`active-win` ships prebuilt helper binaries for Windows and macOS; on macOS the collector needs **Screen Recording** permission to read window titles (System Settings → Privacy & Security). Without it `active-win` returns titles as empty strings and only the app name is categorised.

Development against a local server from the repo root: `npm run collector:dev -- --simulate --accept-notice` (uses the synthetic foreground; see below).

## Simulated mode (Linux / CI)

`--simulate` replaces `active-win` with a deterministic synthetic office day (Outlook → Acrobat → QuickBooks → Excel …, including blocked apps that must never appear in the output) so the whole pipeline can be exercised without a desktop. `--simulate path/to/events.json` instead replays a JSON array of wire events (`{ts,type,app,appCategory?,titleCategory?,titleHash?,durationMs,meta?}`), e.g. one exported from `src/engine/synthetic.ts`. `--once` sends a single batch and exits.

## Deployment samples

### Intune (Windows) — Win32 app or PowerShell script
```powershell
# install.ps1 — run as SYSTEM, installs per-machine, runs per-user at logon
$dest = "$env:ProgramFiles\BridgeBox"; New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item "$PSScriptRoot\bridgebox-collector.exe" $dest -Force
# Per-user enrollment code must be delivered out of band (e.g. via the employee's email); the registry value is read at logon.
Set-ItemProperty -Path "HKLM:\SOFTWARE\Policies\BridgeBox" -Name "Url" -Value "https://app.example.com" -Force
$action  = New-ScheduledTaskAction -Execute "$dest\bridgebox-collector.exe" -Argument "--quiet"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "BridgeBox Collector" -Action $action -Trigger $trigger -RunLevel Limited -Force
```
Set `BRIDGEBOX_URL` as a user environment variable through Intune's **Settings catalog** or a GPO preference, and give each user their code once (`setx BRIDGEBOX_ENROLL_CODE BB-...`). After the first successful run the code is consumed and the token lives in `%LOCALAPPDATA%\BridgeBoxCollector\collector.json`.

### Group Policy (Windows)
User Configuration → Preferences → Windows Settings → Environment: `BRIDGEBOX_URL`. Then a logon script: `"%ProgramFiles%\BridgeBox\bridgebox-collector.exe" --quiet`.

### Jamf (macOS) — LaunchAgent
```xml
<!-- /Library/LaunchAgents/ai.bridgebox.collector.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.bridgebox.collector</string>
  <key>ProgramArguments</key><array><string>/usr/local/bin/bridgebox-collector</string><string>--quiet</string></array>
  <key>EnvironmentVariables</key><dict><key>BRIDGEBOX_URL</key><string>https://app.example.com</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
```
Deploy a PPPC profile granting Screen Recording to the binary, and deliver the enrollment code per user (`launchctl setenv BRIDGEBOX_ENROLL_CODE BB-...` or a first-run prompt).

## Troubleshooting
- `enrollment failed: invalid_or_used_enrollment_code` — the code was used, revoked or is older than 7 days; create a new one.
- `server dropped N: { no_active_campaign }` — collection only happens inside a running campaign that includes this employee.
- `server dropped N: { consent_missing }` — the employee has not acknowledged the current notice version.
- Status `offline` in the web app — no heartbeat for 15 minutes; check the machine is on and can reach the server.
