#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODE_FILE="$ROOT_DIR/code.gs"
HTML_FILE="$ROOT_DIR/index.html"

assert_contains() {
  local file="$1"
  local pattern="$2"
  local message="$3"

  if ! rg -q "$pattern" "$file"; then
    echo "FAIL: $message"
    echo "Missing pattern: $pattern"
    echo "File: $file"
    exit 1
  fi
}

assert_contains "$CODE_FILE" "function getCopyStatus\\(" "backend exposes a copy status API"
assert_contains "$CODE_FILE" "function cancelCopy\\(" "backend exposes a cancel API"
assert_contains "$CODE_FILE" "function resumeCopyNow\\(" "backend exposes a manual resume API"
assert_contains "$CODE_FILE" "triggerCount" "status payload reports scheduled background triggers"
assert_contains "$CODE_FILE" "nextTriggerAt" "status payload reports expected next trigger time"

assert_contains "$HTML_FILE" "backgroundStatus" "UI includes a background status surface"
assert_contains "$HTML_FILE" "getCopyStatus\\(" "UI refreshes copy status from backend"
assert_contains "$HTML_FILE" "cancelCopy\\(" "UI can cancel a background copy"
assert_contains "$HTML_FILE" "resumeCopyNow\\(" "UI can resume a background copy immediately"

echo "Background manager checks passed."
