#!/usr/bin/env bash
# ==============================================================================
# Env & PATH Doctor — Linux / macOS Unified Build & Verification Script
# Usage:
#   ./scripts/build.sh [all|check|frontend|test|bundle|clean] [--debug]
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

TARGET="${1:-all}"
DEBUG_FLAG=""
if [[ "${2:-}" == "--debug" || "${1:-}" == "--debug" ]]; then
  DEBUG_FLAG="--debug"
fi

step() {
  echo ""
  echo "=========================================================="
  echo "[Env & PATH Doctor] $1"
  echo "=========================================================="
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: Required command '$1' was not found. $2" >&2
    exit 1
  fi
}

step "Checking required development toolchain versions"
require_cmd "node" "Please install Node.js (v20+)."
require_cmd "npm" "Please install npm."
require_cmd "cargo" "Please install the Rust toolchain (rustup): https://rustup.rs"

echo "• Node.js : $(node -v)"
echo "• npm     : v$(npm -v)"
echo "• rustc   : $(rustc -V)"
echo "• cargo   : $(cargo -V)"

if [[ "$TARGET" == "clean" ]]; then
  step "Cleaning build caches and artifacts (clean)"
  rm -rf "$PROJECT_ROOT/dist"
  (cd "$PROJECT_ROOT/src-tauri" && cargo clean)
  echo "Clean completed."
  exit 0
fi

if [[ ! -d "$PROJECT_ROOT/node_modules" ]]; then
  step "Installing frontend dependencies (npm install)"
  npm install
fi

if [[ "$TARGET" == "all" || "$TARGET" == "check" || "$TARGET" == "frontend" ]]; then
  step "Building frontend TypeScript & Vite production bundle"
  npm run build
  echo "Frontend build succeeded (dist/)."
fi

if [[ "$TARGET" == "all" || "$TARGET" == "check" || "$TARGET" == "test" ]]; then
  step "Running Rust backend unit tests and compilation checks"
  (
    cd "$PROJECT_ROOT/src-tauri"
    cargo test --lib
    if [[ "$TARGET" == "check" ]]; then
      cargo check --bins
    fi
  )
  echo "Rust backend unit tests and checks passed."
fi

if [[ "$TARGET" == "all" || "$TARGET" == "bundle" ]]; then
  step "Building Tauri v2 desktop packages (.deb / .AppImage / .rpm)"
  npx tauri build $DEBUG_FLAG
  echo ""
  echo "Build completed successfully!"
  echo "Artifacts directory: $PROJECT_ROOT/src-tauri/target/release/bundle"
fi
