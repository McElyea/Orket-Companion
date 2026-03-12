from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import json
import os
import platform
import shutil
import statistics
import subprocess
import sys
import tempfile
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
    parser.add_argument("--http-timeout-sec", type=float, default=60.0)
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument("--output", default="")
    parser.add_argument("--ui-interrupt-probe", action="store_true")
    parser.add_argument("--ui-timeout-sec", type=float, default=90.0)
    parser.add_argument("--ui-headed", action="store_true")
    parser.add_argument(
        "--include-audio",
        action="store_true",
        help="Keep full audio_b64 payload in output (default omits it and reports length only).",
    )
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

def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _system_profile() -> dict[str, Any]:
    return {
        "platform": platform.platform(),
        "system": platform.system(),
        "release": platform.release(),
        "machine": platform.machine(),
        "processor": platform.processor(),
        "python_version": platform.python_version(),
        "cpu_count_logical": os.cpu_count(),
    }

def _typeperf_counter_sample(counter_path: str) -> dict[str, Any]:
    if platform.system() != "Windows":
        return {"available": False, "reason": f"unsupported_platform:{platform.system()}"}
    if shutil.which("typeperf") is None:
        return {"available": False, "reason": "typeperf_not_found"}
    proc = subprocess.run(
        ["typeperf", counter_path, "-sc", "1"],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        return {"available": False, "reason": f"typeperf_failed:{err[:120]}"}
    rows = [
        row
        for row in csv.reader((proc.stdout or "").splitlines())
        if row and any(str(cell).strip() for cell in row)
    ]
    data_rows = [row for row in rows if len(row) > 1 and str(row[0]).strip()[:1].isdigit()]
    if not data_rows:
        return {"available": False, "reason": "typeperf_output_empty"}
    values: list[float] = []
    for raw in data_rows[-1][1:]:
        token = str(raw).strip().strip('"').replace(",", ".")
        if not token:
            continue
        try:
            values.append(float(token))
        except ValueError:
            continue
    if not values:
        return {"available": False, "reason": "typeperf_values_missing"}
    return {"available": True, "samples": [round(v, 2) for v in values]}


def _system_resource_snapshot() -> dict[str, Any]:
    cpu = _typeperf_counter_sample(r"\Processor(_Total)\% Processor Time")
    mem = _typeperf_counter_sample(r"\Memory\% Committed Bytes In Use")
    gpu = _typeperf_counter_sample(r"\GPU Engine(*)\Utilization Percentage")
    snapshot: dict[str, Any] = {
        "timestamp_utc": _utc_now_iso(),
        "cpu_total_percent": None,
        "memory_committed_percent": None,
        "gpu_engine_percent_max": None,
        "gpu_engine_percent_sum": None,
        "notes": [],
    }
    if cpu.get("available"):
        snapshot["cpu_total_percent"] = float(cpu["samples"][0])
    else:
        snapshot["notes"].append({"cpu": cpu.get("reason")})
    if mem.get("available"):
        snapshot["memory_committed_percent"] = float(mem["samples"][0])
    else:
        snapshot["notes"].append({"memory": mem.get("reason")})
    if gpu.get("available"):
        gpu_samples = [max(0.0, float(v)) for v in gpu["samples"]]
        snapshot["gpu_engine_percent_max"] = round(max(gpu_samples), 2)
        snapshot["gpu_engine_percent_sum"] = round(sum(gpu_samples), 2)
    else:
        snapshot["notes"].append({"gpu": gpu.get("reason")})
    if not snapshot["notes"]:
        snapshot.pop("notes")
    return snapshot


def _summarize_voice_payload(result: dict[str, Any], *, include_audio: bool) -> None:
    body = result.get("body")
    if not isinstance(body, dict):
        return
    audio_b64 = body.get("audio_b64")
    if not isinstance(audio_b64, str):
        return
    body["audio_b64_len"] = len(audio_b64)
    if not include_audio:
        body["audio_b64"] = ""


def _safe_elapsed_ms(entry: Any) -> float | None:
    if not isinstance(entry, dict):
        return None
    elapsed = entry.get("elapsed_ms")
    if isinstance(elapsed, (float, int)):
        return float(elapsed)
    return None


def _aggregate_runs(run_results: list[dict[str, Any]]) -> dict[str, Any]:
    keys = [
        "status",
        "chat",
        "voice_synthesize",
        "avatar_event_publish",
        "avatar_event_feed",
    ]
    aggregates: dict[str, Any] = {}
    for key in keys:
        samples = [
            elapsed
            for elapsed in (_safe_elapsed_ms(run.get(key)) for run in run_results)
            if elapsed is not None
        ]
        if not samples:
            continue
        sorted_samples = sorted(samples)
        median = statistics.median(sorted_samples)
        p95_index = min(len(sorted_samples) - 1, max(0, int(round((len(sorted_samples) - 1) * 0.95))))
        aggregates[key] = {
            "count": len(sorted_samples),
            "min_ms": round(sorted_samples[0], 2),
            "max_ms": round(sorted_samples[-1], 2),
            "avg_ms": round(sum(sorted_samples) / len(sorted_samples), 2),
            "median_ms": round(float(median), 2),
            "p95_ms": round(float(sorted_samples[p95_index]), 2),
        }
    return aggregates


def _run_probe_once(
    *,
    client: httpx.Client,
    base_url: str,
    args: argparse.Namespace,
    run_index: int,
) -> dict[str, Any]:
    run_id = run_index + 1
    run_session_id = args.session_id if args.runs <= 1 else f"{args.session_id}-{run_id:02d}"
    run_results: dict[str, Any] = {
        "run_id": run_id,
        "session_id": run_session_id,
        "timestamp_utc": _utc_now_iso(),
    }
    run_results["system_metrics_before"] = _system_resource_snapshot()
    run_results["status"] = _timed_json_request(client, "GET", f"{base_url}/api/status")
    run_results["chat"] = _timed_json_request(
        client,
        "POST",
        f"{base_url}/api/chat",
        headers={"origin": base_url},
        json={
            "session_id": run_session_id,
            "message": args.message,
            "provider": args.provider,
            "model": args.model,
        },
    )
    run_results["voice_synthesize"] = _timed_json_request(
        client,
        "POST",
        f"{base_url}/api/voice/synthesize",
        headers={"origin": base_url},
        json={
            "text": "phase d synth probe",
            "voice_id": "",
            "emotion_hint": "neutral",
            "speed": 1.0,
        },
    )
    _summarize_voice_payload(
        run_results["voice_synthesize"],
        include_audio=bool(args.include_audio),
    )
    run_results["avatar_event_publish"] = _timed_json_request(
        client,
        "POST",
        f"{base_url}/api/avatar/control-events",
        headers={"origin": base_url},
        json={
            "type": "avatar.expression",
            "version": "avatar_event_v1",
            "session_id": "companion-main",
            "ts": _utc_now_iso(),
            "idempotency_key": f"phase-d-probe-event-{run_id}",
            "payload": {"expression": "smile"},
        },
    )
    run_results["avatar_event_feed"] = _timed_json_request(
        client,
        "GET",
        f"{base_url}/api/avatar/control-events",
        params={"session_id": "companion-main", "after_seq": 0, "limit": 10},
    )
    run_results["system_metrics_after"] = _system_resource_snapshot()
    return run_results


def _write_output_if_requested(summary: dict[str, Any], output_path_raw: str) -> str | None:
    output_path = str(output_path_raw or "").strip()
    if not output_path:
        return None
    path = Path(output_path).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return str(path.resolve())


def _run_ui_interrupt_probe(*, companion_root: str, base_url: str, args: argparse.Namespace) -> dict[str, Any]:
    ui_root = Path(companion_root) / "UI"
    runner = Path("scripts") / "live_ui_interrupt_probe.mjs"
    with tempfile.TemporaryDirectory(prefix="companion-ui-probe-") as temp_dir:
        output_path = Path(temp_dir) / "ui_interrupt_probe.json"
        cmd = [
            "node",
            str(runner),
            "--base-url",
            base_url,
            "--message",
            args.message,
            "--timeout-sec",
            str(float(args.ui_timeout_sec)),
            "--provider",
            args.provider,
            "--model",
            args.model,
            "--output",
            str(output_path),
        ]
        if args.ui_headed:
            cmd.append("--headed")
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=False,
            cwd=str(ui_root),
        )
        result_payload: dict[str, Any]
        if output_path.exists():
            try:
                result_payload = json.loads(output_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                result_payload = {
                    "ok": False,
                    "error": "ui_probe_output_parse_failed",
                }
        else:
            result_payload = {
                "ok": False,
                "error": "ui_probe_output_missing",
            }
        result_payload["exit_code"] = int(proc.returncode)
        if proc.stderr and proc.returncode != 0:
            result_payload["stderr"] = proc.stderr.strip()
        if proc.returncode != 0:
            result_payload["ok"] = False
        return result_payload


def main() -> int:
    args = _parse_args()
    _configure_environment(args)
    _sys_path_insert(args.orket_root, args.companion_root)
    os.chdir(args.orket_root)

    from companion_app.server import app as gateway_app
    from orket.interfaces.api import app as host_app

    host_server = uvicorn.Server(
        uvicorn.Config(host_app, host="127.0.0.1", port=args.host_port, log_level="critical", access_log=False),
    )
    gateway_server = uvicorn.Server(
        uvicorn.Config(gateway_app, host="127.0.0.1", port=args.gateway_port, log_level="critical", access_log=False),
    )

    host_thread = threading.Thread(target=host_server.run, daemon=True)
    gateway_thread = threading.Thread(target=gateway_server.run, daemon=True)
    host_thread.start()
    time.sleep(args.startup_wait_sec)
    gateway_thread.start()

    summary: dict[str, Any] = {
        "ok": True,
        "timestamp_utc": _utc_now_iso(),
        "host_port": args.host_port,
        "gateway_port": args.gateway_port,
        "piper_enabled": bool(args.enable_piper),
        "measurement_profile": {
            "runs": max(1, int(args.runs)),
            "http_timeout_sec": float(args.http_timeout_sec),
            "startup_wait_sec": float(args.startup_wait_sec),
            "provider": args.provider,
            "model": args.model,
            "ui_interrupt_probe": bool(args.ui_interrupt_probe),
            "ui_timeout_sec": float(args.ui_timeout_sec),
            "system_metrics_mode": "windows_typeperf_snapshots",
        },
        "system_profile": _system_profile(),
        "results": {},
        "runs": [],
    }

    try:
        time.sleep(args.startup_wait_sec)
        base = f"http://127.0.0.1:{args.gateway_port}"
        with httpx.Client(timeout=float(args.http_timeout_sec)) as client:
            run_count = max(1, int(args.runs))
            for run_index in range(run_count):
                run_result = _run_probe_once(
                    client=client,
                    base_url=base,
                    args=args,
                    run_index=run_index,
                )
                summary["runs"].append(run_result)
            first_run = summary["runs"][0] if summary["runs"] else {}
            summary["results"] = {
                key: first_run[key]
                for key in (
                    "status",
                    "chat",
                    "voice_synthesize",
                    "avatar_event_publish",
                    "avatar_event_feed",
                )
                if key in first_run
            }
            summary["aggregates"] = _aggregate_runs(summary["runs"])
            if args.ui_interrupt_probe:
                summary["ui_interrupt_probe"] = _run_ui_interrupt_probe(
                    companion_root=args.companion_root,
                    base_url=base,
                    args=args,
                )
                if not bool(summary["ui_interrupt_probe"].get("ok")):
                    summary["ok"] = False
                    summary["error"] = "ui_interrupt_probe_failed"
    except Exception as exc:  # top-level script boundary
        summary["ok"] = False
        summary["error"] = str(exc)
    finally:
        gateway_server.should_exit = True
        host_server.should_exit = True
        gateway_thread.join(timeout=6)
        host_thread.join(timeout=6)

    output_path = str(args.output or "").strip()
    if output_path:
        summary["output_path"] = str(Path(output_path).expanduser().resolve())
        _write_output_if_requested(summary, output_path)
    return 0 if summary.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
