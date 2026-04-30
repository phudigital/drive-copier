#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODE_FILE="$ROOT_DIR/Code.gs"
HTML_FILE="$ROOT_DIR/Index.html"

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

assert_not_contains() {
  local file="$1"
  local pattern="$2"
  local message="$3"

  if rg -q "$pattern" "$file"; then
    echo "FAIL: $message"
    echo "Unexpected pattern: $pattern"
    echo "File: $file"
    exit 1
  fi
}

assert_contains "$CODE_FILE" "const SPACE_CHECK_MS = 120000;" "space check has a longer but bounded runtime"
assert_contains "$CODE_FILE" "const SPACE_CHECK_MAX_DEPTH = 5;" "space check scans the expected depth from the source folder"
assert_not_contains "$CODE_FILE" "SPACE_CHECK_FILE_LIMIT" "space check should not stop early by file count"
assert_not_contains "$CODE_FILE" "SPACE_CHECK_FOLDER_LIMIT" "space check should not stop early by folder count"
assert_contains "$CODE_FILE" "function estimateFolderSizeByDepth\\(" "backend has a depth-limited exact scan helper"
assert_contains "$CODE_FILE" "Drive.Files.list" "space check uses Drive API listing for faster recursive scans"
assert_contains "$CODE_FILE" "files\\(id, mimeType, size\\)" "space check fetches only the metadata needed for size"
assert_contains "$CODE_FILE" "depthLimitHit" "space check reports when a tree is deeper than the configured depth"
assert_contains "$CODE_FILE" "timedOut" "space check reports when it stops due to runtime guard"

assert_contains "$HTML_FILE" "Đã quét đủ" "space UI tells the user when the scan is complete"
assert_contains "$HTML_FILE" "r.maxDepth" "space UI displays the configured depth limit"
assert_contains "$HTML_FILE" "r.depthLimitHit" "space UI explains depth-limited partial scans"
assert_contains "$HTML_FILE" "r.timedOut" "space UI explains timeout-limited partial scans"

echo "Depth-limited space check passed."
