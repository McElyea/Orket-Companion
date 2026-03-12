# Orket Companion Extension

Companion is an external SDK extension with a local web gateway/UI. The web app talks only to the extension gateway, and the gateway talks to Orket Host API (`/api/v1/companion/*`).

## Validation
1. `python -m orket_extension_sdk.validate . --json`
2. `python -m orket_extension_sdk.import_scan src --json`
3. `python -m orket.interfaces.orket_bundle_cli ext validate C:\Source\Orket-Extensions\Companion --json`
4. If `orket` is not importable in the current environment, run:
   - PowerShell: ``$env:PYTHONPATH='C:\Source\Orket'; python -m orket.interfaces.orket_bundle_cli ext validate C:\Source\Orket-Extensions\Companion --json``

## Companion UI stack (MVP)
1. React + Vite + TypeScript
2. SCSS Modules
3. Radix UI primitives
4. Lucide icons
5. Plain `fetch` with a thin typed client

## Avatar foundation contract (current)
1. UI-local persisted settings use `avatar_prefs_v1` (`mode`, `renderer`, `asset_ref`, `motion_profile`, `fallback_policy`).
2. Settings migration fails closed to safe defaults and emits a non-fatal warning event (`avatar.settings_migration_failed`).
3. Local-only avatar asset policy is enforced; remote URLs and unsupported file types fail closed to fallback rendering.
4. Renderer seam is explicit (`fallback` and `vrm`) with deterministic fallback activation when assets are missing, blocked, or fail to load.
5. Lifecycle state precedence is deterministic (`speaking > listening > thinking > idle`) through the avatar lifecycle coordinator.
6. Avatar observability emits the baseline vocabulary (`avatar.renderer_selected`, `avatar.asset_load_*`, `avatar.fallback_activated`, `avatar.state_changed`, `avatar.lipsync_*`) with rate-limited repeated warning events.
7. Optional gateway-backed avatar control-event feed is available at `/api/avatar/control-events` (`POST` publish + `GET` feed) with envelope validation and idempotency-safe sequencing.
8. Speaking mouth-open baseline is playback-derived from decoded audio amplitude with reduced-motion capping, and stops immediately on playback end/interruption.

## Build frontend (when editing UI source)
1. `npm --prefix UI install`
2. `npm --prefix UI test`
3. `npm --prefix UI run build`

## Run end to end (secure-by-default)
1. Start Orket host API with key scoping:
   - `set ORKET_API_KEY=core-key`
   - `set ORKET_COMPANION_API_KEY=companion-key`
   - `set ORKET_COMPANION_KEY_STRICT=true`
   - Start host (matches `py server.py` defaults): `py server.py`
   - Optional explicit host launch: `python -m uvicorn orket.interfaces.api:app --host 127.0.0.1 --port 8082`
2. Start Companion gateway/UI:
   - `set COMPANION_HOST_BASE_URL=http://127.0.0.1:8082`
   - `set COMPANION_API_KEY=companion-key`
   - Optional UI bind controls:
     - `COMPANION_UI_HOST` (default `127.0.0.1`)
     - `COMPANION_UI_PORT` (default `3000`, starting port)
     - `COMPANION_UI_MAX_PORT` (default `COMPANION_UI_PORT + 20`)
   - Launch:
     - PowerShell: `.\scripts\run.ps1`
     - Unix: `./scripts/run.sh`
   - The run scripts auto-detect a local Orket host on `8082`, then `18082`, then `8000` when `COMPANION_HOST_BASE_URL` is unset.
   - If `COMPANION_API_KEY` is unset, the run scripts reuse `ORKET_COMPANION_API_KEY` or `ORKET_API_KEY` when those are already present in the same shell.
3. Open the printed URL (the run script auto-falls to the next open port if needed). Set `COMPANION_UI_PORT=3001` if you want the legacy `127.0.0.1:3001` URL.
4. For live speaking/lipsync verification, set `ORKET_TTS_BACKEND=piper` with a valid `ORKET_TTS_PIPER_MODEL_PATH` (and optional `ORKET_TTS_PIPER_BIN`). If no PATH shim is present for `piper`, runtime falls back to `python -m piper` when the module is installed.

## Avatar asset refs
1. Companion serves UI assets from `/static/...`.
2. A built-in starter avatar is available at `/static/assets/companion-avatar.svg`.
3. For avatar images or VRM/GLTF assets stored under the UI static tree, use refs such as `/static/assets/companion-avatar.svg`.
4. Legacy `assets/...` refs are normalized to `/static/assets/...` at render time for backward compatibility.

## Quick live smoke checks
1. `Invoke-RestMethod http://127.0.0.1:3000/api/status`
2. `Invoke-RestMethod http://127.0.0.1:3000/api/chat -Method Post -Headers @{Origin='http://127.0.0.1:3000'} -ContentType 'application/json' -Body '{"session_id":"smoke","message":"hello"}'`
3. Reproducible Phase D baseline probe (host + gateway + chat + voice synth + avatar control-feed):
   - `python scripts/live_phase_d_probe.py --orket-root C:\Source\Orket --companion-root C:\Source\Orket-Extensions\Companion --output .\tmp\phase-d-probe.json`
   - Add `--runs <N>` for repeated baseline samples with aggregate latency statistics.
   - Pin `--model llama3.1:8b` for lower-latency, more stable local chat responses when heavier defaults are slow or timeout-prone.
   - For TTS-enabled live probes, add `--enable-piper --piper-model-path C:\Source\Orket\data\voices\en_US-lessac-medium.onnx --piper-voices-dir C:\Source\Orket\data\voices`.
   - The probe is silent by default and writes canonical JSON only when `--output <path>` is supplied.
   - Per run, the probe now captures `system_metrics_before` / `system_metrics_after` snapshots (CPU, memory, and GPU engine utilization) via Windows `typeperf` when available.
   - Add `--ui-interrupt-probe` to execute a real browser interruption/cancel check (`Speak Last Reply` -> `Stop Playback`) against the live UI path, including browser-side navigation timing and sampled FPS metrics.
   - Add `--ui-headed` for visible browser mode when debugging the UI interruption probe.
   - Add `--include-audio` only when full `audio_b64` payload is required in output.
   - Use `--http-timeout-sec <seconds>` if the local model is slow to respond on first warmup.
4. Advanced UI-only probe options (run directly when you need longer FPS windows or avatar-mode-specific sampling):
   - `node UI/scripts/live_ui_interrupt_probe.mjs --base-url http://127.0.0.1:3000 --provider ollama --model llama3.1:8b --raf-sample-sec 60 --speaking-raf-sample-sec 60 --avatar-mode avatar --output .\tmp\ui-interrupt-probe.json`
   - The UI probe is also silent by default and only writes JSON when `--output <path>` is supplied.
   - Probe output includes `performance_metrics.synced_notice_ms` (UI-ready/TTI proxy), navigation timings, and idle/speaking RAF FPS samples.

## Gateway hardening
1. Missing `COMPANION_API_KEY` fails closed with `E_COMPANION_GATEWAY_API_KEY_REQUIRED`.
2. Non-loopback clients are blocked by default (`E_COMPANION_GATEWAY_LOOPBACK_REQUIRED`).
3. Mutating requests enforce same-origin by default (`E_COMPANION_GATEWAY_CSRF_BLOCKED`).
4. Payload size guardrails return `413` for oversized config/chat/audio payloads.

