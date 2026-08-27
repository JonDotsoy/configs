#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATE="$SCRIPT_DIR/../scripts/validate-commit-message.sh"
FAILURES=0

run_test() {
  local fn="$1" desc="$2"
  if $fn; then
    echo "OK   $desc"
  else
    echo "FAIL $desc"
    ((FAILURES++))
  fi
}

assert_exits_ok() {
  local msg="$1"
  bash "$VALIDATE" "$msg" > /dev/null 2>&1
}

assert_exits_err() {
  local msg="$1"
  ! bash "$VALIDATE" "$msg" > /dev/null 2>&1
}

# ── Mensajes válidos ────────────────────────────────────────────────────────────

test_tipo_sin_scope() {
  assert_exits_ok "feat: add billing filter"
}

test_tipo_con_scope() {
  assert_exits_ok "fix(api): correct date parsing"
}

test_con_body() {
  assert_exits_ok "$(printf 'refactor(db): simplify query layer\n\nRemoves the intermediate mapping step that was never used.')"
}

test_tipo_feat()     { assert_exits_ok "feat: x"; }
test_tipo_fix()      { assert_exits_ok "fix: x"; }
test_tipo_refactor() { assert_exits_ok "refactor: x"; }
test_tipo_test()     { assert_exits_ok "test: x"; }
test_tipo_docs()     { assert_exits_ok "docs: x"; }
test_tipo_chore()    { assert_exits_ok "chore: x"; }
test_tipo_style()    { assert_exits_ok "style: x"; }
test_tipo_perf()     { assert_exits_ok "perf: x"; }
test_tipo_build()    { assert_exits_ok "build: x"; }
test_tipo_ci()       { assert_exits_ok "ci: x"; }
test_tipo_revert()   { assert_exits_ok "revert: x"; }

test_subject_exactamente_72_chars() {
  # "feat: " = 6 chars, padding hasta 72 en total
  local subject
  subject="feat: $(printf '%0.s-' {1..66})"
  assert_exits_ok "$subject"
}

# ── Tipo inválido ───────────────────────────────────────────────────────────────

test_tipo_update_invalido() {
  assert_exits_err "update(api): change endpoint"
}

test_tipo_add_invalido() {
  assert_exits_err "add: new feature"
}

test_sin_tipo() {
  assert_exits_err "just a message without type"
}

# ── Formato del subject ─────────────────────────────────────────────────────────

test_sin_espacio_tras_colon() {
  assert_exits_err "feat:no space after colon"
}

test_scope_con_espacio_invalido() {
  assert_exits_err "feat(my scope): has space in scope"
}

test_sin_descripcion() {
  assert_exits_err "feat: "
}

# ── Largo del subject ───────────────────────────────────────────────────────────

test_subject_73_chars() {
  local subject
  subject="feat: $(printf '%0.s-' {1..67})"
  assert_exits_err "$subject"
}

# ── Punto final ────────────────────────────────────────────────────────────────

test_punto_final_en_subject() {
  assert_exits_err "fix(consola): correct null pointer."
}

# ── Separador de body ───────────────────────────────────────────────────────────

test_body_sin_linea_en_blanco() {
  assert_exits_err "$(printf 'feat: add feature\nthis body has no blank line separator')"
}

test_body_con_linea_en_blanco() {
  assert_exits_ok "$(printf 'feat: add feature\n\nThis body is correctly separated.')"
}

# ── Largo de líneas del body ────────────────────────────────────────────────────

test_body_linea_exactamente_72_chars() {
  local line
  line="$(printf '%0.s-' {1..72})"
  assert_exits_ok "$(printf "feat: ok\n\n%s" "$line")"
}

test_body_linea_73_chars() {
  local line
  line="$(printf '%0.s-' {1..73})"
  assert_exits_err "$(printf "feat: ok\n\n%s" "$line")"
}

# ── Trailer Co-Authored-By ──────────────────────────────────────────────────────

test_sin_coauthor_trailer_es_valido() {
  assert_exits_ok "feat: add feature"
}

test_con_coauthor_trailer_es_rechazado() {
  assert_exits_err "$(printf 'feat: add feature\n\nCo-Authored-By: Claude <noreply@anthropic.com>')"
}

test_con_coauthor_trailer_minuscula_es_rechazado() {
  assert_exits_err "$(printf 'feat: add feature\n\nCo-authored-by: someone else')"
}

# ── Runner ──────────────────────────────────────────────────────────────────────

run_test test_tipo_sin_scope         "feat: simple message is valid"
run_test test_tipo_con_scope         "fix(api): message with scope is valid"
run_test test_con_body               "message with blank-line-separated body is valid"
run_test test_tipo_feat              "type 'feat' is valid"
run_test test_tipo_fix               "type 'fix' is valid"
run_test test_tipo_refactor          "type 'refactor' is valid"
run_test test_tipo_test              "type 'test' is valid"
run_test test_tipo_docs              "type 'docs' is valid"
run_test test_tipo_chore             "type 'chore' is valid"
run_test test_tipo_style             "type 'style' is valid"
run_test test_tipo_perf              "type 'perf' is valid"
run_test test_tipo_build             "type 'build' is valid"
run_test test_tipo_ci                "type 'ci' is valid"
run_test test_tipo_revert            "type 'revert' is valid"
run_test test_subject_exactamente_72_chars "subject of exactly 72 chars is valid"

run_test test_tipo_update_invalido   "type 'update' is rejected"
run_test test_tipo_add_invalido      "type 'add' is rejected"
run_test test_sin_tipo               "message without type is rejected"

run_test test_sin_espacio_tras_colon  "missing space after colon is rejected"
run_test test_scope_con_espacio_invalido "scope with space is rejected"
run_test test_sin_descripcion        "empty description after colon is rejected"

run_test test_subject_73_chars       "subject of 73 chars is rejected"

run_test test_punto_final_en_subject "trailing period in subject is rejected"

run_test test_body_sin_linea_en_blanco "body without blank line separator is rejected"
run_test test_body_con_linea_en_blanco "body with blank line separator is valid"

run_test test_body_linea_exactamente_72_chars "body line of exactly 72 chars is valid"
run_test test_body_linea_73_chars    "body line of 73 chars is rejected"

run_test test_sin_coauthor_trailer_es_valido          "message without Co-Authored-By trailer is valid"
run_test test_con_coauthor_trailer_es_rechazado       "message with Co-Authored-By trailer is rejected"
run_test test_con_coauthor_trailer_minuscula_es_rechazado "message with lowercase co-authored-by trailer is rejected"

[[ $FAILURES -eq 0 ]] || exit 1
