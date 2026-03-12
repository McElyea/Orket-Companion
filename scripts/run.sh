#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
cd "${repo_root}"

ui_host="${COMPANION_UI_HOST:-127.0.0.1}"
start_port="${COMPANION_UI_PORT:-3000}"
max_port="${COMPANION_UI_MAX_PORT:-$((start_port + 20))}"
verbose_logging="${COMPANION_VERBOSE_LOGGING:-}"
host_api_candidates=(
  "http://127.0.0.1:8082"
  "http://127.0.0.1:18082"
  "http://127.0.0.1:8000"
)

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
      break
    fi
  done
  export COMPANION_HOST_BASE_URL="${COMPANION_HOST_BASE_URL:-${host_api_candidates[0]}}"
fi

if [ -z "${COMPANION_API_KEY:-}" ]; then
  if [ -n "${ORKET_COMPANION_API_KEY:-}" ]; then
    export COMPANION_API_KEY="${ORKET_COMPANION_API_KEY}"
  elif [ -n "${ORKET_API_KEY:-}" ]; then
    export COMPANION_API_KEY="${ORKET_API_KEY}"
  fi
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
