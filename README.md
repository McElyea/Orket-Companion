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
   - Start host: `python -m uvicorn orket.interfaces.api:app --host 127.0.0.1 --port 18082`
2. Start Companion gateway/UI:
   - `set COMPANION_HOST_BASE_URL=http://127.0.0.1:18082`
   - `set COMPANION_API_KEY=companion-key`
   - Optional UI bind controls:
     - `COMPANION_UI_HOST` (default `127.0.0.1`)
     - `COMPANION_UI_PORT` (default `3000`, starting port)
     - `COMPANION_UI_MAX_PORT` (default `COMPANION_UI_PORT + 20`)
   - Launch:
     - PowerShell: `.\scripts\run.ps1`
     - Unix: `./scripts/run.sh`
3. Open the printed URL (the run script auto-falls to the next open port if needed).
4. For live speaking/lipsync verification, set `ORKET_TTS_BACKEND=piper` with a valid `ORKET_TTS_PIPER_MODEL_PATH` (and optional `ORKET_TTS_PIPER_BIN`). If no PATH shim is present for `piper`, runtime falls back to `python -m piper` when the module is installed.

## Quick live smoke checks
1. `Invoke-RestMethod http://127.0.0.1:3000/api/status`
2. `Invoke-RestMethod http://127.0.0.1:3000/api/chat -Method Post -Headers @{Origin='http://127.0.0.1:3000'} -ContentType 'application/json' -Body '{"session_id":"smoke","message":"hello"}'`
3. Reproducible Phase D baseline probe (host + gateway + chat + voice synth + avatar control-feed):
   - `python scripts/live_phase_d_probe.py --orket-root C:\Source\Orket --companion-root C:\Source\Orket-Extensions\Companion`
   - Add `--runs <N>` for repeated baseline samples with aggregate latency statistics.
   - Add `--output <path>` to write canonical JSON results for later comparison.
   - Add `--ui-interrupt-probe` to execute a real browser interruption/cancel check (`Speak Last Reply` -> `Stop Playback`) against the live UI path, including browser-side navigation timing and sampled FPS metrics.
   - Add `--ui-headed` for visible browser mode when debugging the UI interruption probe.
   - Add `--include-audio` only when full `audio_b64` payload is required in output.
   - Use `--http-timeout-sec <seconds>` if the local model is slow to respond on first warmup.

## Gateway hardening
1. Missing `COMPANION_API_KEY` fails closed with `E_COMPANION_GATEWAY_API_KEY_REQUIRED`.
2. Non-loopback clients are blocked by default (`E_COMPANION_GATEWAY_LOOPBACK_REQUIRED`).
3. Mutating requests enforce same-origin by default (`E_COMPANION_GATEWAY_CSRF_BLOCKED`).
4. Payload size guardrails return `413` for oversized config/chat/audio payloads.

