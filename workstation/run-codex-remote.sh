#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

export SISO_WORKSTATION_DEFAULT_ROOT="${SISO_WORKSTATION_DEFAULT_ROOT:-$HOME}"
export SISO_WORKSTATION_DEFAULT_CWD="${SISO_WORKSTATION_DEFAULT_CWD:-$SISO_WORKSTATION_DEFAULT_ROOT}"
export SISO_WORKSTATION_TIMEOUT_MS="${SISO_WORKSTATION_TIMEOUT_MS:-120000}"

if [ ! -d node_modules ]; then
  npm install
fi

node server.mjs
