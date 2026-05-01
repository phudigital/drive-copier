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

assert_contains "$CODE_FILE" "const COPY_MAX_PARALLEL_SESSIONS = 3;" "backend caps parallel copy sessions at 3"
assert_contains "$CODE_FILE" "COPY_SESSION_REGISTRY_KEY" "backend keeps a registry of copy sessions"
assert_contains "$CODE_FILE" "COPY_SESSION_STATE_PREFIX" "backend stores state per session"
assert_contains "$CODE_FILE" "COPY_SESSION_PROGRESS_PREFIX" "backend stores progress per session"
assert_contains "$CODE_FILE" "function getCopySessions\\(" "backend exposes all copy sessions"
assert_contains "$CODE_FILE" "function promoteQueuedSessions\\(" "backend promotes queued sessions when slots open"
assert_contains "$CODE_FILE" "function getCopyStatus\\(sessionId" "copy status can be read for one session"
assert_contains "$CODE_FILE" "function continueCopyByTrigger\\(e\\)" "trigger handler receives event data"
assert_contains "$CODE_FILE" "triggerUid" "trigger handler maps a trigger back to one session"
assert_contains "$CODE_FILE" "state.sessionId" "copy state carries its own session id"
assert_contains "$CODE_FILE" "status: 'queued'" "backend can return a queued copy session"
assert_contains "$CODE_FILE" "activeSessions.length >= COPY_MAX_PARALLEL_SESSIONS" "backend queues when the active cap is reached"
assert_contains "$CODE_FILE" "parallelCopyEnabled: true" "dashboard reports parallel mode as enabled"
assert_contains "$CODE_FILE" "maxParallelSessions: COPY_MAX_PARALLEL_SESSIONS" "dashboard reports the max parallel limit"
assert_not_contains "$CODE_FILE" "parallelCopyEnabled: false" "dashboard must no longer report single-session mode"

assert_contains "$HTML_FILE" "sessionStartMode" "UI has a start-mode choice for new copy sessions"
assert_contains "$HTML_FILE" "selectSessionMode\\(" "UI lets the user choose wait vs parallel"
assert_contains "$HTML_FILE" "makeClientSessionId\\(" "UI creates a stable session id per tab copy"
assert_contains "$HTML_FILE" "activeSessionId" "UI tracks the active session for the current tab"
assert_contains "$HTML_FILE" "getProgress\\(activeSessionId\\)" "progress polling reads only the current tab session"
assert_contains "$HTML_FILE" "copyItem\\(args\\[0\\], args\\[1\\], args\\[2\\], args\\[3\\], args\\[4\\]\\)" "UI passes start mode and session id to copyItem"
assert_contains "$HTML_FILE" "renderCopySessions\\(" "Trigger tab renders per-session copy cards"
assert_contains "$HTML_FILE" "cancelCopy\\(sessionId\\)" "UI can cancel one session"
assert_contains "$HTML_FILE" "resumeCopyNow\\(sessionId\\)" "UI can resume one session"
assert_contains "$HTML_FILE" "Tạo phiên song song" "UI exposes the parallel-session choice"
assert_contains "$HTML_FILE" "Chờ" "UI exposes the queued-session choice"

echo "Parallel copy session checks passed."
