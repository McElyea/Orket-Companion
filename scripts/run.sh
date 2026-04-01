#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
cd "${repo_root}"

load_dotenv_files() {
  python - "$@" <<'PY'
import os
import re
import sys

name_pattern = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
file_values: dict[str, str] = {}
loaded_names: list[str] = []

for path in sys.argv[1:]:
    if not os.path.isfile(path):
        continue
    loaded_names.append(os.path.basename(path))
    with open(path, "r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:].lstrip()
            if "=" not in line:
                continue
            name, value = line.split("=", 1)
            name = name.strip()
            if not name_pattern.match(name):
                continue
            value = value.strip()
            if len(value) >= 2 and ((value[0] == value[-1] == '"') or (value[0] == value[-1] == "'")):
                value = value[1:-1]
            file_values[name] = value

for name, value in file_values.items():
    if not os.getenv(name, "").strip():
        print(f"EXPORT\t{name}\t{value}")

for loaded_name in loaded_names:
    print(f"LOADED\t{loaded_name}\t")
PY
}

loaded_env_files=()
while IFS=$'\t' read -r record_type first second; do
  case "${record_type}" in
    EXPORT)
      export "${first}=${second}"
      ;;
    LOADED)
      loaded_env_files+=("${first}")
      ;;
  esac
done < <(load_dotenv_files "${repo_root}/.env" "${repo_root}/.env.local")

ui_host="${COMPANION_UI_HOST:-127.0.0.1}"
start_port="${COMPANION_UI_PORT:-3000}"
max_port="${COMPANION_UI_MAX_PORT:-$((start_port + 20))}"
verbose_logging="${COMPANION_VERBOSE_LOGGING:-}"
host_api_candidates=(
  "http://127.0.0.1:8082"
  "http://127.0.0.1:18082"
  "http://127.0.0.1:8000"
)
host_api_provided="${COMPANION_HOST_BASE_URL:-}"
resolved_host_api_from_candidate=""

if [ "${max_port}" -lt "${start_port}" ]; then
  echo "COMPANION_UI_MAX_PORT (${max_port}) must be >= COMPANION_UI_PORT (${start_port})." >&2
  exit 2
fi

test_host_api_reachable() {
  python - <<'PY' "$1"
import socket
import sys
from urllib.parse import urlparse

parsed = urlparse(sys.argv[1])
host = parsed.hostname
port = parsed.port

if not host or not port:
    raise SystemExit(1)

sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.settimeout(0.5)
try:
    sock.connect((host, port))
except OSError:
    raise SystemExit(1)
finally:
    sock.close()
PY
}

if [ -z "${COMPANION_HOST_BASE_URL:-}" ]; then
  for candidate in "${host_api_candidates[@]}"; do
    if test_host_api_reachable "${candidate}"; then
      export COMPANION_HOST_BASE_URL="${candidate}"
      resolved_host_api_from_candidate="${candidate}"
      break
    fi
  done
  export COMPANION_HOST_BASE_URL="${COMPANION_HOST_BASE_URL:-${host_api_candidates[0]}}"
fi

if [ -z "${COMPANION_API_KEY:-}" ]; then
  if [ -n "${ORKET_API_KEY:-}" ]; then
    export COMPANION_API_KEY="${ORKET_API_KEY}"
  fi
fi

missing_api_key=""
if [ -z "${COMPANION_API_KEY:-}" ]; then
  missing_api_key="1"
fi

ui_port="$(
python - <<'PY' "${ui_host}" "${start_port}" "${max_port}"
import socket
import sys

host = sys.argv[1]
start_port = int(sys.argv[2])
max_port = int(sys.argv[3])

for port in range(start_port, max_port + 1):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind((host, port))
    except OSError:
        pass
    else:
        print(port)
        sock.close()
        raise SystemExit(0)
    finally:
        try:
            sock.close()
        except OSError:
            pass

raise SystemExit(1)
PY
)"

if [ -z "${ui_port}" ]; then
  echo "No open UI port found in range ${start_port}-${max_port} on ${ui_host}." >&2
  exit 1
fi

if [ -z "${host_api_provided}" ] && [ -z "${resolved_host_api_from_candidate}" ]; then
  echo "Warning: no local Orket host API was reachable on ${host_api_candidates[*]}. Defaulting COMPANION_HOST_BASE_URL to ${COMPANION_HOST_BASE_URL}." >&2
fi
if [ -n "${missing_api_key}" ]; then
  echo "Warning: COMPANION_API_KEY is not set. Starting Companion in degraded mode; host-backed /api/* requests will fail until COMPANION_API_KEY or ORKET_API_KEY is set." >&2
fi
if [ "${#loaded_env_files[@]}" -gt 0 ]; then
  echo "Loaded env defaults from ${loaded_env_files[*]}"
fi
if [ "${ui_port}" != "${start_port}" ]; then
  echo "Companion UI port ${start_port} is unavailable; using ${ui_port} instead."
fi
echo "Launching Companion gateway/UI at http://${ui_host}:${ui_port}"
echo "Host API base URL: ${COMPANION_HOST_BASE_URL}"
case "${verbose_logging}" in
  1|true|TRUE|True|yes|YES|on|ON)
    echo "Server logging: verbose"
    ;;
  *)
    echo "Server logging: quiet (set COMPANION_VERBOSE_LOGGING=1 for uvicorn startup logs)"
    ;;
esac
echo "Press Ctrl+C to stop."

uvicorn_args=(
  -m uvicorn companion_app.server:app
  --app-dir src
  --host "${ui_host}"
  --port "${ui_port}"
)

case "${verbose_logging}" in
  1|true|TRUE|True|yes|YES|on|ON)
    ;;
  *)
    uvicorn_args+=(--no-access-log --log-level critical)
    ;;
esac

python "${uvicorn_args[@]}"
