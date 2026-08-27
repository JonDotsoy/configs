---
name: scoped-commits
description: Analyzes all pending repo changes (staged, unstaged, and untracked), groups them into cohesive commits by scope, infers the Conventional Commits type for each group, and creates one commit per group. Does not push.
license: MIT
metadata:
  author: Jonathan Delgado <hi@jon.soy> (https://jon.soy)
  version: "1.0"
---

# Scoped Commits

Splits a repo's pending state (a mix of fixes, features, docs, config...) into separate,
coherent commits — each with its correct `type(scope): subject`. It's the next step after
the `commit-message` skill: that one assumes you've already decided what goes in the
staging area; this one decides **how to split** a working tree with changes of different
natures and does the `git add`/`git commit` work for each partition. The scope ends there:
it never runs `git push` — that's left to the user's judgment.

## When to use it

The user asks to "push the changes", "commit this in parts", "split the commit by scope",
or there's an obvious mix of unrelated changes (e.g. a domain fix + a demo feature + a docs
update) in the same working tree.

Don't use it if there's already a single cohesive change staged — `commit-message` is
enough there.

## Workflow

### 1. Survey the full repo state

Run in parallel:

```bash
git status --porcelain          # NEVER with -uall (memory issues on large repos) — the
                                 # "normal" (default) mode already lists every untracked file
git --no-pager diff              # unstaged changes
git --no-pager diff --staged     # changes already in the index (if the user ran `git add` beforehand)
git --no-pager log --format="%s%n%b" -10   # recent style/vocabulary of the repo
git branch --show-current
```

If `git status --porcelain` returns nothing, report "No pending changes" and stop.

Treat staged + unstaged + untracked as a single set to partition — don't assume what's
already in the index is a correct partition; it may be half-finished work from another
session.

### 2. Inspect each changed file

For each path in `git status --porcelain`, look at its actual diff (`git diff HEAD -- <path>`
for tracked files; read the full file if it's new/untracked) before classifying it. Don't
decide the group or type based solely on extension or folder — the diff content is the
source of truth (a change in `docs/` might actually document a fix and deserve to go in the
same commit as the fix, not in a separate "docs" commit).

### 3. Discard what shouldn't be committed

Before grouping, identify and **exclude** from any commit:

- **Generated artifacts/runtime state**: builds (`dist/`, `build/`), logs, local databases
  (`*.sqlite*`), caches, tool captures/sessions (`.playwright-mcp/`, `.DS_Store`), state
  directories of locally-run instances (like `demo/configs/` in this repo — each subfolder
  was the state of a `publite` instance spun up for testing, not source code). If they
  aren't already in `.gitignore`, propose adding them there (as part of a `chore` commit or
  the most related commit) **instead of** committing them. Never delete these files — just
  exclude them from staging.
- **Possible secrets**: an ungitignored `.env`, `*.pem`, `*.key`, `credentials.json`,
  hardcoded tokens visible in the diff. If something like this appears, **stop and ask** the
  user instead of deciding on your own — don't include the file in any commit until they
  confirm.
- If something is ambiguous (is it a legitimate test fixture or a generated file?), don't
  guess — ask.

### 4. Group the rest into cohesive commits

Grouping criteria, in this order of priority:

1. **Logical cohesion first**: files that only make sense together go together, even if
   they live in different folders (a fix + its test + the doc line documenting the
   invariant that fix enforces are a single commit, not three).
2. **Module/folder boundary next**, when there's no obvious cross-coupling (e.g. a `demo/`
   feature unrelated to a `src/core/` fix are two separate commits).
3. If, within a single file, the diff visibly mixes two unrelated scopes (two unrelated
   hunks), **don't** try to split by hunk (`git add -p`) automatically — flag it to the
   user and ask how to separate it instead of guessing.
4. Never leave an intermediate commit deliberately broken: if one file renames a function
   and another updates all its call sites, they go in the same commit.

### 5. Infer the `type` for each group

| Type | Signal in the diff |
| --- | --- |
| `feat` | New functionality visible to the user or system; rename of a known public API/name |
| `fix` | Fixes an already-detected/reproduced bug |
| `perf` | Reduces code or improves the performance of existing functionality, without adding new behavior |
| `refactor` | Restructures code without changing observable behavior or the core domain APIs' names |
| `test` | Adds or modifies tests (functional or performance) |
| `docs` | User/integrator-facing documentation (README, `docs/*`, comments) — **not** agent-instruction files |
| `chore` | Version bump, adding/updating a dependency, tooling config (Playwright, linters, local CI, editorconfig...), **updating `AGENTS.md`/`CLAUDE.md`**, adding or modifying the license |
| `build` | Project build/packaging scripts |
| `ci` | Code used only in the CI environment (GitHub Actions workflows, etc.) |

Notes:
- `AGENTS.md`/`CLAUDE.md` are `chore` **only if the change is its own group**. If the edit
  to that file directly documents the behavior of a `fix`/`feat` landing in the same
  commit (like adding an invariant that explains the fix), follow the cohesion rule from
  step 4 and keep it with the code — don't force it into a separate `chore`.
- Pick the **most specific** type that applies. If a group still mixes two clearly
  distinct types, that's a sign the grouping from step 4 was wrong — repartition it before
  continuing.
- The **scope** is the most representative subsystem/folder/component of the group (same
  criterion as the `commit-message` skill: e.g. `demo`, `core`, `cli`, `config`). Omit it
  if the change is repo-wide.

### 6. Draft and validate each message

Same rules as the `commit-message` skill (format, imperative mood, repo's language, ≤72
characters per line, body explains the *why*). The message **never** carries a
`Co-Authored-By` trailer (see the template in step 8). Validate each message before
committing:

```bash
bash scripts/validate-commit-message.sh "<generated message>"
```

If it fails, fix and re-validate. Never commit a message that didn't pass validation.

### 7. Present the plan before touching git

Show the user, in a single block, the proposed partition: for each future commit, its
`type(scope): subject` and the list of files it includes — and, if applicable, which files
you're excluding (generated/ambiguous) and what you'd add to `.gitignore`. This replaces
asking for permission step by step: show the full plan once, and if nothing is ambiguous or
risky (see step 3), proceed straight to execution.

### 8. Execute: one commit per group

For each group, in order (config/infra first, then fixes/refactors, then features, tests,
and docs last — an order that helps readability of history, not a strict rule):

```bash
git add <file1> <file2> ...   # NEVER `git add -A` or `git add .`
git commit -m "$(cat <<'EOF'
<type>(<scope>): <subject>

<optional body>
EOF
)"
```

- Never `--amend`, never `--no-verify`, never `-c commit.gpgsign=false`.
- If a pre-commit hook fails, fix the issue and create a **new** commit — don't retry with
  `--amend`.
- `.gitignore` updates to exclude artifacts detected in step 3 go in the corresponding
  `chore` commit (or the most related commit if the gitignore entry arises from that same
  change), never on their own without context.

### 9. Verify

```bash
git status        # should end up clean (nothing pending from the processed groups)
git log --oneline -<n>   # confirm the n new commits, in order
```

Don't run `git push`: this skill's scope ends at leaving the commits created locally.
Pushing them is left to the user's judgment (or another skill/explicit instruction).

### 10. Report

Brief summary: how many commits were created, their `type(scope): subject`, and what was
left out (files excluded as generated/ambiguous, and whether anything was added to
`.gitignore`).

## Partition example

Working tree with: a fix in `src/core/store.ts` + its test, a new feature in `demo/`, and
user docs in `docs/`:

```
1) fix(core): reject writes on a read-only secondary
   src/core/store.ts, src/errors.ts, test/store.test.ts

2) feat(demo): spawn real instances from the instance launcher
   demo/demo.ts, demo/public/components/instance-launcher.js

3) docs: document the read-only replica guard
   docs/replication/README.md, docs/cli.md, docs/rest-api.md
```

Each one is committed and validated separately; pushing is out of this skill's scope.
