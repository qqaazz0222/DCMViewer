#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

APP_NAME="DCMViewer"
ARCH="arm64"
TARGETS=(dmg zip)

log() {
	printf '\n[%s] %s\n' "$APP_NAME" "$1"
}

verify_command() {
	if ! command -v "$1" >/dev/null 2>&1; then
		printf '[%s] Required command not found: %s\n' "$APP_NAME" "$1" >&2
		exit 1
	fi

	if ! "$1" --version >/dev/null 2>&1; then
		printf '[%s] Required command is installed but cannot run: %s\n' "$APP_NAME" "$1" >&2
		exit 1
	fi
}

verify_command node
verify_command npm
verify_command npx

if [[ "$(uname -s)" != "Darwin" ]]; then
	log "Warning: macOS packages must be built on macOS for reliable DMG output."
fi

if [[ ! -d node_modules ]]; then
	log "Installing dependencies with npm ci"
	npm ci
fi

export CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-false}"

log "Building renderer and Electron main process"
npm run build

log "Packaging macOS arm64 desktop app (${TARGETS[*]})"
npx electron-builder --mac "${TARGETS[@]}" --"$ARCH"

log "Done. Packaged files are in: $ROOT_DIR/release"
