#!/usr/bin/env bash
# Validates a commit message against Conventional Commits rules.
# Usage:
#   echo "<message>" | bash validate-commit-message.sh
#   bash validate-commit-message.sh "<message>"
set -euo pipefail

if [[ $# -ge 1 ]]; then
  MSG="$1"
else
  MSG="$(cat)"
fi

SUBJECT="$(printf '%s' "$MSG" | head -1)"
LINE2="$(printf '%s' "$MSG" | sed -n '2p')"
BODY="$(printf '%s' "$MSG" | tail -n +3)"
# awk counts lines correctly even when the string has no trailing newline
TOTAL_LINES="$(printf '%s' "$MSG" | awk 'END{print NR}')"

# ── helpers ───────────────────────────────────────────────────────────────────

FAILURES=0

run_test() {
  local fn=$1 desc=$2
  local output
  if output=$("$fn" 2>&1); then
    printf "  OK  %s\n" "$desc"
  else
    printf "FAIL  %s\n" "$desc"
    [[ -n "$output" ]] && printf "      %s\n" "$output"
    FAILURES=$((FAILURES + 1))
  fi
}

assert_true() {
  local condition=$1 msg=$2
  if ! eval "$condition"; then
    echo "$msg"
    return 1
  fi
}

# ── tests ─────────────────────────────────────────────────────────────────────

VALID_TYPES="feat|fix|refactor|test|docs|chore|style|perf|build|ci|revert"
SUBJECT_PATTERN="^(${VALID_TYPES})(\([^) ]+\))?: .+"

test_subject_format() {
  if ! printf '%s' "$SUBJECT" | grep -qE "$SUBJECT_PATTERN"; then
    echo "no coincide con '<type>(<scope>): <subject>' o '<type>: <subject>'"
    echo "tipos válidos: feat fix refactor test docs chore style perf build ci revert"
    echo "obtenido: ${SUBJECT:-<vacío>}"
    return 1
  fi
}

test_subject_length() {
  local len=${#SUBJECT}
  if [[ $len -gt 72 ]]; then
    echo "primera línea tiene $len caracteres (máximo 72)"
    return 1
  fi
}

test_no_trailing_period() {
  if [[ "$SUBJECT" =~ \.$ ]]; then
    echo "la primera línea termina con punto"
    return 1
  fi
}

test_body_separator() {
  if [[ "$TOTAL_LINES" -gt 1 ]] && [[ -n "$LINE2" ]]; then
    echo "la línea 2 debe estar vacía (separa subject de body)"
    echo "obtenido: '${LINE2}'"
    return 1
  fi
}

test_body_line_length() {
  [[ -z "$BODY" ]] && return 0
  local failed=0
  while IFS= read -r line; do
    local len=${#line}
    if [[ $len -gt 72 ]]; then
      echo "línea del body tiene $len caracteres (máximo 72):"
      echo "  $line"
      failed=1
    fi
  done <<< "$BODY"
  [[ $failed -eq 0 ]]
}

test_no_coauthor() {
  if printf '%s' "$MSG" | grep -qiE '^Co-Authored-By:'; then
    echo "el mensaje no debe incluir el trailer 'Co-Authored-By'"
    return 1
  fi
}

# ── runner ────────────────────────────────────────────────────────────────────

run_test test_subject_format    "subject sigue <type>(<scope>): <msg> o <type>: <msg>"
run_test test_subject_length    "primera línea ≤ 72 caracteres"
run_test test_no_trailing_period "sin punto final en el subject"
run_test test_body_separator    "línea 2 vacía si hay body"
run_test test_body_line_length  "líneas del body ≤ 72 caracteres"
run_test test_no_coauthor       "no incluye el trailer Co-Authored-By"

[[ $FAILURES -eq 0 ]] || exit 1
