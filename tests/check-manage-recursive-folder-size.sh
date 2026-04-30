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

assert_contains "$CODE_FILE" "function summarizeFolderTreeLimited\\(" "backend has a recursive bounded folder summary helper"
assert_contains "$CODE_FILE" "summarizeFolderTreeLimited\\(folder.id" "manage folder list uses recursive summaries"
assert_contains "$CODE_FILE" "folder.folderCount = summary.folderCount" "manage folder payload includes recursive subfolder count"
assert_contains "$CODE_FILE" "folder.partial = summary.partial" "manage folder payload marks partial scans"
assert_not_contains "$CODE_FILE" "childQuery =" "manage folder list should not use direct-file-only childQuery sizing"

assert_contains "$HTML_FILE" "f.partial \\? '≥ ' : ''" "manage UI marks partial recursive sizes as lower-bound estimates"
assert_contains "$HTML_FILE" "f.folderCount" "manage UI displays recursive subfolder counts"

echo "Recursive manage folder size checks passed."
