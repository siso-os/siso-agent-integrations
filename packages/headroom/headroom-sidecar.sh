#!/usr/bin/env bash
set -euo pipefail

# Opt-in Headroom lane adapter. It never edits Claude, Codex, Bifrost, go-llm-proxy,
# or Headroom settings. The persistent routing switch remains an operator decision.

SISO_HEADROOM_DATA_ROOT="${SISO_HEADROOM_DATA_ROOT:-${XDG_DATA_HOME:-${HOME}/.local/share}/siso-agent-integrations/headroom}"
SISO_HEADROOM_STATE_DIR="${SISO_HEADROOM_STATE_DIR:-${XDG_STATE_HOME:-${HOME}/.local/state}/siso-headroom}"
HEADROOM_BIN="${HEADROOM_BIN:-${SISO_HEADROOM_DATA_ROOT}/bin/headroom}"
SISO_HEADROOM_HOST="${SISO_HEADROOM_HOST:-127.0.0.1}"
SISO_HEADROOM_PORT="${SISO_HEADROOM_PORT:-18790}"
SISO_HEADROOM_ANTHROPIC_UPSTREAM="${SISO_HEADROOM_ANTHROPIC_UPSTREAM:-http://127.0.0.1:8789}"
SISO_HEADROOM_OPENAI_UPSTREAM="${SISO_HEADROOM_OPENAI_UPSTREAM:-https://api.openai.com}"
SISO_HEADROOM_URL="http://${SISO_HEADROOM_HOST}:${SISO_HEADROOM_PORT}"
SISO_HEADROOM_INTEGRATION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SISO_HEADROOM_LAUNCH_LABEL="com.siso.headroom.lossless"
SISO_HEADROOM_LAUNCH_PLIST="${HOME}/Library/LaunchAgents/${SISO_HEADROOM_LAUNCH_LABEL}.plist"

usage() {
  cat <<'EOF'
Usage:
  headroom-sidecar.sh enable
  headroom-sidecar.sh disable
  headroom-sidecar.sh status
  headroom-sidecar.sh start
  headroom-sidecar.sh check
  headroom-sidecar.sh minimax [claude-mini arguments...]
  headroom-sidecar.sh codex [codex arguments...]

Environment:
  HEADROOM_BIN                       pinned Headroom executable
  SISO_HEADROOM_PORT                 loopback port (default: 18790)
  SISO_HEADROOM_ANTHROPIC_UPSTREAM   existing MiniMax/go-llm upstream (default: :8789)
  SISO_HEADROOM_OPENAI_UPSTREAM      existing OpenAI-compatible upstream
  SISO_HEADROOM_RUNTIME_DIR          ephemeral Headroom workspace/log directory
  SISO_HEADROOM_STATE_DIR            owned pid/log/runtime directory
  SISO_MINIMAX_LAUNCHER              MiniMax-compatible launcher (default: claude-mini)

This is a conservative pilot: stateless, local telemetry and update checks off,
no learning, no semantic response cache, no rate limiter, no subscription poll,
no CCR/tool injection, no ML downloads, and byte/data-lossless compaction only.
EOF
}

require_loopback() {
  case "$SISO_HEADROOM_HOST" in
    127.0.0.1|localhost|::1) ;;
    *)
      echo "headroom-sidecar: refusing non-loopback host: $SISO_HEADROOM_HOST" >&2
      exit 64
      ;;
  esac
}

check() {
  curl --fail --silent --show-error --max-time 3 "${SISO_HEADROOM_URL}/readyz"
}

enable() {
  require_loopback
  if check >/dev/null 2>&1; then
    echo "headroom-sidecar: already ready at $SISO_HEADROOM_URL"
    return 0
  fi
  mkdir -p "$SISO_HEADROOM_STATE_DIR"
  chmod 700 "$SISO_HEADROOM_STATE_DIR"

  if [[ "$(uname -s)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1; then
    if [[ ! -f "$SISO_HEADROOM_LAUNCH_PLIST" ]]; then
      echo "headroom-sidecar: LaunchAgent is not installed: $SISO_HEADROOM_LAUNCH_PLIST" >&2
      exit 69
    fi
    launch_domain="gui/$(id -u)"
    launch_service="${launch_domain}/${SISO_HEADROOM_LAUNCH_LABEL}"
    if ! launchctl print "$launch_service" >/dev/null 2>&1; then
      for _bootstrap_attempt in {1..12}; do
        if launchctl bootstrap "$launch_domain" "$SISO_HEADROOM_LAUNCH_PLIST" >/dev/null 2>&1; then
          break
        fi
        sleep 0.25
      done
      if ! launchctl print "$launch_service" >/dev/null 2>&1; then
        echo "headroom-sidecar: launchd bootstrap failed for ${SISO_HEADROOM_LAUNCH_LABEL}" >&2
        exit 70
      fi
    fi
    launchctl kickstart -k "$launch_service"
    for _attempt in {1..40}; do
      if check >/dev/null 2>&1; then
        # Immediate readiness is insufficient when launchd startup later fails.
        sleep 1
        if check >/dev/null 2>&1; then
          launch_pid="$(launchctl print "$launch_service" | awk '/pid = / {print $3; exit}')"
          echo "headroom-sidecar: enabled launchd_pid=${launch_pid:-unknown} url=$SISO_HEADROOM_URL"
          return 0
        fi
      fi
      sleep 0.25
    done
    echo "headroom-sidecar: launchd readiness timeout; see $SISO_HEADROOM_STATE_DIR/sidecar.log" >&2
    exit 70
  fi

  pid_file="$SISO_HEADROOM_STATE_DIR/sidecar.pid"
  if [[ -f "$pid_file" ]]; then
    old_pid="$(tr -dc '0-9' < "$pid_file")"
    if [[ -n "$old_pid" ]] && kill -0 "$old_pid" >/dev/null 2>&1; then
      echo "headroom-sidecar: owned process $old_pid exists but is not ready; refusing a second start" >&2
      exit 69
    fi
  fi
  nohup env \
    HEADROOM_BIN="$HEADROOM_BIN" \
    SISO_HEADROOM_HOST="$SISO_HEADROOM_HOST" \
    SISO_HEADROOM_PORT="$SISO_HEADROOM_PORT" \
    SISO_HEADROOM_ANTHROPIC_UPSTREAM="$SISO_HEADROOM_ANTHROPIC_UPSTREAM" \
    SISO_HEADROOM_OPENAI_UPSTREAM="$SISO_HEADROOM_OPENAI_UPSTREAM" \
    SISO_HEADROOM_RUNTIME_DIR="$SISO_HEADROOM_STATE_DIR/runtime" \
    "$0" start >"$SISO_HEADROOM_STATE_DIR/sidecar.log" 2>&1 &
  child_pid=$!
  pid_tmp="$(mktemp "$SISO_HEADROOM_STATE_DIR/sidecar.pid.XXXXXX")"
  printf '%s\n' "$child_pid" > "$pid_tmp"
  mv "$pid_tmp" "$pid_file"
  for _attempt in {1..40}; do
    if check >/dev/null 2>&1; then
      echo "headroom-sidecar: enabled pid=$child_pid url=$SISO_HEADROOM_URL"
      return 0
    fi
    if ! kill -0 "$child_pid" >/dev/null 2>&1; then
      echo "headroom-sidecar: failed to start; see $SISO_HEADROOM_STATE_DIR/sidecar.log" >&2
      exit 70
    fi
    sleep 0.25
  done
  echo "headroom-sidecar: readiness timeout; see $SISO_HEADROOM_STATE_DIR/sidecar.log" >&2
  exit 70
}

disable() {
  if [[ "$(uname -s)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1; then
    launch_service="gui/$(id -u)/${SISO_HEADROOM_LAUNCH_LABEL}"
    if launchctl print "$launch_service" >/dev/null 2>&1; then
      launchctl bootout "$launch_service"
      for _attempt in {1..40}; do
        if ! check >/dev/null 2>&1; then
          echo "headroom-sidecar: disabled launchd service ${SISO_HEADROOM_LAUNCH_LABEL}"
          return 0
        fi
        sleep 0.25
      done
      echo "headroom-sidecar: launchd service did not stop" >&2
      exit 70
    fi
  fi
  pid_file="$SISO_HEADROOM_STATE_DIR/sidecar.pid"
  if [[ ! -f "$pid_file" ]]; then
    if check >/dev/null 2>&1; then
      echo "headroom-sidecar: ready process is not owned by this harness; refusing to stop it" >&2
      exit 69
    fi
    echo "headroom-sidecar: already disabled"
    return 0
  fi
  owned_pid="$(tr -dc '0-9' < "$pid_file")"
  if [[ -z "$owned_pid" ]] || ! kill -0 "$owned_pid" >/dev/null 2>&1; then
    rm -f "$pid_file"
    echo "headroom-sidecar: removed stale pid file"
    return 0
  fi
  owned_command="$(ps -p "$owned_pid" -o command= 2>/dev/null || true)"
  if [[ "$owned_command" != *headroom*proxy* ]]; then
    echo "headroom-sidecar: pid $owned_pid is not an owned Headroom proxy; refusing to stop it" >&2
    exit 69
  fi
  kill "$owned_pid"
  for _attempt in {1..40}; do
    if ! kill -0 "$owned_pid" >/dev/null 2>&1; then
      rm -f "$pid_file"
      echo "headroom-sidecar: disabled pid=$owned_pid"
      return 0
    fi
    sleep 0.25
  done
  echo "headroom-sidecar: pid $owned_pid did not stop; no force-kill attempted" >&2
  exit 70
}

status() {
  if check >/dev/null 2>&1; then
    echo "headroom-sidecar: READY $SISO_HEADROOM_URL"
    return 0
  fi
  echo "headroom-sidecar: DISABLED $SISO_HEADROOM_URL"
  return 1
}

start() {
  require_loopback
  if ! command -v "$HEADROOM_BIN" >/dev/null 2>&1 && [[ ! -x "$HEADROOM_BIN" ]]; then
    echo "headroom-sidecar: Headroom executable not found: $HEADROOM_BIN" >&2
    exit 127
  fi
  headroom_bin_path="$(command -v "$HEADROOM_BIN" 2>/dev/null || printf '%s' "$HEADROOM_BIN")"
  headroom_python="${SISO_HEADROOM_PYTHON:-$(dirname "$headroom_bin_path")/python}"
  if [[ ! -x "$headroom_python" ]]; then
    echo "headroom-sidecar: Headroom Python not found: $headroom_python" >&2
    exit 127
  fi
  if command -v nc >/dev/null 2>&1 && nc -z "$SISO_HEADROOM_HOST" "$SISO_HEADROOM_PORT" >/dev/null 2>&1; then
    echo "headroom-sidecar: port is already in use: $SISO_HEADROOM_URL" >&2
    exit 69
  fi
  if curl --fail --silent --max-time 1 "${SISO_HEADROOM_URL}/livez" >/dev/null 2>&1; then
    echo "headroom-sidecar: port already serves Headroom: $SISO_HEADROOM_URL" >&2
    exit 69
  fi

  runtime_dir="${SISO_HEADROOM_RUNTIME_DIR:-$(mktemp -d /tmp/siso-headroom-runtime.XXXXXX)}"
  mkdir -p "$runtime_dir"
  echo "headroom-sidecar: runtime=$runtime_dir" >&2
  echo "headroom-sidecar: anthropic_upstream=$SISO_HEADROOM_ANTHROPIC_UPSTREAM" >&2

  export HEADROOM_WORKSPACE_DIR="$runtime_dir"
  export HEADROOM_CONFIG_DIR="$runtime_dir/config"
  export HEADROOM_STATELESS=true
  export HEADROOM_TELEMETRY=off
  export HEADROOM_OTEL_METRICS_ENABLED=false
  export HEADROOM_UPDATE_CHECK=off
  export HEADROOM_SAVINGS_PROFILE=coding
  # The coding profile enables several structural transforms by default. Keep
  # this lane strictly lossless: tool definitions, tool order, and request
  # topology must remain byte-for-byte stable outside compacted result text.
  export HEADROOM_TOOL_SEARCH=0
  export HEADROOM_DEDUPE=0
  export HEADROOM_LOSSLESS_THEN_LOSSY=0
  export HEADROOM_OPENAI_TOOL_SEARCH_MODELS='^$'
  # Lossless-only mode can compact the newest tool result without accuracy risk.
  export HEADROOM_PROTECT_RECENT=0
  export HEADROOM_COMPRESS_USER_MESSAGES=false
  export HEADROOM_LOG_MESSAGES=0
  export HEADROOM_SYSTEM_COMPACT=0
  export HEADROOM_TOOL_DESC_MAX_CHARS=0
  export HEADROOM_TOOL_DESC_STRIP_SEMANTIC=0
  export HEADROOM_OUTPUT_SHAPER=0
  export HEADROOM_READ_MATURATION=0
  export HEADROOM_PROXY_EXTENSIONS=""
  export HEADROOM_CODEX_WIRE_DEBUG=0
  export HEADROOM_NET_COST_POLICY=0
  export HEADROOM_EXPERIMENTAL_READ_KEEP_RATIO=0
  export HEADROOM_DISABLE_KOMPRESS_ANTHROPIC=1
  export HEADROOM_DISABLE_KOMPRESS_OPENAI=1
  export HEADROOM_FORCE_KOMPRESS_ALL=0
  export HEADROOM_COMPRESS_PASSTHROUGH=0
  export HEADROOM_TEXT_CRUSHER=0
  export HEADROOM_BACKGROUND_COMPRESSION=0
  export HEADROOM_MODEL_ROUTER_ENABLED=0
  export HEADROOM_COMPRESS_SYSTEM_MESSAGES=0
  export HEADROOM_LOSSLESS_ONLY=1
  export HF_HUB_DISABLE_IMPLICIT_TOKEN=1
  export HF_HUB_DISABLE_PROGRESS_BARS=1
  # HEADROOM_INTERCEPT_ENABLED is checked for string presence, so even "0"
  # enables it. It must be absent rather than assigned a false-looking value.
  unset HEADROOM_LICENSE_KEY HEADROOM_PROXY_TOKEN HEADROOM_INTERCEPT_ENABLED
  unset HEADROOM_CODEX_WIRE_DEBUG_DIR HEADROOM_LOG_FILE
  unset HEADROOM_KOMPRESS_ENDPOINT HEADROOM_KOMPRESS_ENDPOINT_TOKEN
  unset HEADROOM_KOMPRESS_TOKEN HEADROOM_HTTP_PROXY
  unset HEADROOM_MODEL_ROUTES HEADROOM_TOOL_PROFILES HEADROOM_COMPRESSORS
  # Replace ambient import paths so an unrelated user module cannot execute in
  # this provider-facing process. The only injected module is the audited shim.
  export PYTHONPATH="${SISO_HEADROOM_INTEGRATION_DIR}/python"

  exec "$headroom_python" -m siso_headroom_entry proxy \
    --host "$SISO_HEADROOM_HOST" \
    --port "$SISO_HEADROOM_PORT" \
    --workers 1 \
    --mode cache \
    --stateless \
    --no-telemetry \
    --no-learn \
    --no-cache \
    --no-rate-limit \
    --no-subscription-tracking \
    --no-read-lifecycle \
    --retry-max-attempts 1 \
    --lossless \
    --no-ccr \
    --disable-kompress \
    --disable-kompress-fallback \
    --no-code-aware \
    --no-http2 \
    --anthropic-api-url "$SISO_HEADROOM_ANTHROPIC_UPSTREAM" \
    --openai-api-url "$SISO_HEADROOM_OPENAI_UPSTREAM"
}

run_minimax() {
  check >/dev/null
  minimax_launcher="${SISO_MINIMAX_LAUNCHER:-claude-mini}"
  if ! command -v "$minimax_launcher" >/dev/null 2>&1; then
    echo "headroom-sidecar: MiniMax launcher not found: $minimax_launcher" >&2
    exit 69
  fi
  MINIMAX_BASE_URL="$SISO_HEADROOM_URL" exec "$minimax_launcher" "$@"
}

run_codex() {
  check >/dev/null
  exec codex \
    -c 'model_provider="headroom"' \
    -c 'model_providers.headroom.name="Headroom loopback pilot"' \
    -c "model_providers.headroom.base_url=\"${SISO_HEADROOM_URL}/v1\"" \
    -c 'model_providers.headroom.requires_openai_auth=true' \
    -c 'model_providers.headroom.supports_websockets=false' \
    "$@"
}

case "${1:-}" in
  enable) enable ;;
  disable) disable ;;
  status) status ;;
  start) start ;;
  check) check ;;
  minimax) shift; run_minimax "$@" ;;
  codex) shift; run_codex "$@" ;;
  -h|--help|help|"") usage ;;
  *) usage >&2; exit 64 ;;
esac
