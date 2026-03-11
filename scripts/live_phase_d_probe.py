from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any

import httpx
import uvicorn


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a local Companion Phase D baseline probe.")
    parser.add_argument("--orket-root", default=r"C:\Source\Orket")
    parser.add_argument("--companion-root", default=r"C:\Source\Orket-Extensions\Companion")
    parser.add_argument("--host-port", type=int, default=18140)
    parser.add_argument("--gateway-port", type=int, default=18141)
    parser.add_argument("--session-id", default="phase-d-probe")
    parser.add_argument("--message", default="phase d probe ping")
    parser.add_argument("--provider", default="ollama")
    parser.add_argument("--model", default="Command-R:35B")
    parser.add_argument("--enable-piper", action="store_true")
    parser.add_argument("--piper-model-path", default="")
    parser.add_argument("--piper-voices-dir", default="")
    parser.add_argument("--piper-bin", default="piper")
    parser.add_argument("--startup-wait-sec", type=float, default=2.0)
    return parser.parse_args()


def _configure_environment(args: argparse.Namespace) -> None:
    os.environ["ORKET_API_KEY"] = "core-key"
    os.environ["ORKET_COMPANION_API_KEY"] = "companion-key"
    os.environ["ORKET_COMPANION_KEY_STRICT"] = "true"
    os.environ["COMPANION_HOST_BASE_URL"] = f"http://127.0.0.1:{args.host_port}"
    os.environ["COMPANION_API_KEY"] = "companion-key"
    if args.enable_piper:
        os.environ["ORKET_TTS_BACKEND"] = "piper"
        if args.piper_model_path:
            os.environ["ORKET_TTS_PIPER_MODEL_PATH"] = args.piper_model_path
        if args.piper_voices_dir:
            os.environ["ORKET_TTS_PIPER_VOICES_DIR"] = args.piper_voices_dir
        os.environ["ORKET_TTS_PIPER_BIN"] = args.piper_bin


def _sys_path_insert(repo_root: str, companion_root: str) -> None:
    sys.path.insert(0, str(Path(repo_root)))
    sys.path.insert(0, str(Path(companion_root) / "src"))


def _timed_json_request(
    client: httpx.Client,
    method: str,
    url: str,
    **kwargs: Any,
) -> dict[str, Any]:
    started = time.perf_counter()
    response = client.request(method, url, **kwargs)
    elapsed_ms = round((time.perf_counter() - started) * 1000.0, 2)
    payload: Any
    try:
        payload = response.json()
    except ValueError:
        payload = {"raw": response.text}
    return {
        "http_status": int(response.status_code),
        "elapsed_ms": elapsed_ms,
        "body": payload,
    }


def main() -> int:
    args = _parse_args()
    _configure_environment(args)
    _sys_path_insert(args.orket_root, args.companion_root)
    os.chdir(args.orket_root)

    from companion_app.server import app as gateway_app
    from orket.interfaces.api import app as host_app

    host_server = uvicorn.Server(
        uvicorn.Config(host_app, host="127.0.0.1", port=args.host_port, log_level="warning"),
    )
    gateway_server = uvicorn.Server(
        uvicorn.Config(gateway_app, host="127.0.0.1", port=args.gateway_port, log_level="warning"),
    )

    host_thread = threading.Thread(target=host_server.run, daemon=True)
    gateway_thread = threading.Thread(target=gateway_server.run, daemon=True)
    host_thread.start()
    time.sleep(args.startup_wait_sec)
    gateway_thread.start()

    summary: dict[str, Any] = {
        "ok": True,
        "host_port": args.host_port,
        "gateway_port": args.gateway_port,
        "piper_enabled": bool(args.enable_piper),
        "results": {},
    }

    try:
        time.sleep(args.startup_wait_sec)
        base = f"http://127.0.0.1:{args.gateway_port}"
        with httpx.Client(timeout=30.0) as client:
            summary["results"]["status"] = _timed_json_request(client, "GET", f"{base}/api/status")
            summary["results"]["chat"] = _timed_json_request(
                client,
                "POST",
                f"{base}/api/chat",
                headers={"origin": base},
                json={
                    "session_id": args.session_id,
                    "message": args.message,
                    "provider": args.provider,
                    "model": args.model,
                },
            )
            summary["results"]["voice_synthesize"] = _timed_json_request(
                client,
                "POST",
                f"{base}/api/voice/synthesize",
                headers={"origin": base},
                json={
                    "text": "phase d synth probe",
                    "voice_id": "",
                    "emotion_hint": "neutral",
                    "speed": 1.0,
                },
            )
            summary["results"]["avatar_event_publish"] = _timed_json_request(
                client,
                "POST",
                f"{base}/api/avatar/control-events",
                headers={"origin": base},
                json={
                    "type": "avatar.expression",
                    "version": "avatar_event_v1",
                    "session_id": "companion-main",
                    "ts": "2026-03-11T00:00:00.000Z",
                    "idempotency_key": "phase-d-probe-event-1",
                    "payload": {"expression": "smile"},
                },
            )
            summary["results"]["avatar_event_feed"] = _timed_json_request(
                client,
                "GET",
                f"{base}/api/avatar/control-events",
                params={"session_id": "companion-main", "after_seq": 0, "limit": 10},
            )
    except Exception as exc:  # top-level script boundary
        summary["ok"] = False
        summary["error"] = str(exc)
    finally:
        gateway_server.should_exit = True
        host_server.should_exit = True
        gateway_thread.join(timeout=6)
        host_thread.join(timeout=6)

    print(json.dumps(summary, indent=2))
    return 0 if summary.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
