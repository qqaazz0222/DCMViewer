#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

APP_NAME="DCMViewer"
ARCH="ia32"
TARGETS=(nsis zip)

log() {
	printf '\n[%s] %s\n' "$APP_NAME" "$1"
}

fail() {
	printf '[%s] %s\n' "$APP_NAME" "$1" >&2
	exit 1
}

verify_command() {
	if ! command -v "$1" >/dev/null 2>&1; then
		fail "Required command not found: $1"
	fi

	if ! "$1" --version >/dev/null 2>&1; then
		fail "Required command is installed but cannot run: $1"
	fi
}

verify_command node
verify_command npm
verify_command npx

if [[ "$(uname -s)" == "Darwin" ]]; then
	if ! command -v wine >/dev/null 2>&1; then
		fail "Wine is required for Windows NSIS cross-builds on macOS. Install it first, for example: brew install --cask wine-stable"
	fi
else
	log "Warning: this script is intended for macOS-to-Windows cross-builds. Continuing on $(uname -s)."
fi

if [[ ! -d node_modules ]]; then
	log "Installing dependencies with npm ci"
	npm ci
fi

export CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-false}"

log "Building renderer and Electron main process"
npm run build

log "Packaging Windows x86 desktop app (${TARGETS[*]})"
npx electron-builder --win "${TARGETS[@]}" --"$ARCH"

log "Done. Packaged files are in: $ROOT_DIR/release"
