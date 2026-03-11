# Orket Companion Extension

Companion is an external SDK extension with a local web gateway/UI. The web app talks only to the extension gateway, and the gateway talks to Orket Host API (`/api/v1/companion/*`).

## Validation
1. `python -m orket_extension_sdk.validate . --json`
2. `python -m orket_extension_sdk.import_scan src --json`
3. `python -m orket.interfaces.orket_bundle_cli ext validate C:\Source\Orket-Extensions\Companion --json`

## Companion UI stack (MVP)
1. React + Vite + TypeScript
2. SCSS Modules
3. Radix UI primitives
4. Lucide icons
5. Plain `fetch` with a thin typed client

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

## Quick live smoke checks
1. `Invoke-RestMethod http://127.0.0.1:3000/api/status`
2. `Invoke-RestMethod http://127.0.0.1:3000/api/chat -Method Post -Headers @{Origin='http://127.0.0.1:3000'} -ContentType 'application/json' -Body '{"session_id":"smoke","message":"hello"}'`

## Gateway hardening
1. Missing `COMPANION_API_KEY` fails closed with `E_COMPANION_GATEWAY_API_KEY_REQUIRED`.
2. Non-loopback clients are blocked by default (`E_COMPANION_GATEWAY_LOOPBACK_REQUIRED`).
3. Mutating requests enforce same-origin by default (`E_COMPANION_GATEWAY_CSRF_BLOCKED`).
4. Payload size guardrails return `413` for oversized config/chat/audio payloads.

