# Scoped Commits

Splits a repo's pending changes (staged, unstaged, and untracked) into cohesive,
separately-typed commits — inferring `type(scope)` per group. Does not push.

## Overview

The Scoped Commits skill automates the "I have a pile of unrelated changes, commit them
properly" workflow by:

- Reading the full pending diff (`git status`, unstaged `git diff`, staged `git diff --staged`)
- Filtering out generated/runtime artifacts (build output, logs, local databases, tool
  session state) instead of committing them — proposing a `.gitignore` entry in their place
- Grouping the remaining files by logical cohesion first, module/folder boundary second
- Inferring a Conventional Commits `type` per group from an explicit heuristics table
- Drafting, validating, and creating one commit per group

It's the multi-commit counterpart to the `commit-message` skill: `commit-message` assumes
you already decided what belongs in a single commit; `scoped-commits` decides how to split
an entire working tree into several.

## Installation

```bash
# Using npx
npx skills add jondotsoy/skills --skill scoped-commits

# Using bunx
bunx skills add jondotsoy/skills --skill scoped-commits
```

## Usage

Just ask your AI assistant, with a mixed working tree:

```
"sube los cambios por scope"
"commit these changes, split by scope"
"separate this into a fix commit and a docs commit"
```

### Prerequisites

- A git repository with pending changes (staged, unstaged, and/or untracked)
- No additional tools required beyond `git` and `bash`

## Type Inference Table

| Type | Signal |
|------|--------|
| `feat` | New user/system-visible functionality; rename of a known public API |
| `fix` | Fixes an already-detected bug |
| `perf` | Reduces code or improves performance of existing functionality |
| `refactor` | Restructures code without changing observable behavior or core domain API names |
| `test` | Adds or modifies tests (functional or performance) |
| `docs` | User/integrator-facing documentation (README, `docs/*`, comments) — not agent-instruction files |
| `chore` | Version bump, dependency changes, tooling config (Playwright, linters...), **AGENTS.md/CLAUDE.md updates**, license changes |
| `build` | Build/packaging scripts |
| `ci` | CI-only code (GitHub Actions workflows, etc.) |

`AGENTS.md`/`CLAUDE.md` count as `chore` only when they're their own group — if the edit
directly documents a fix/feat landing in the same commit, cohesion wins and it stays with
the code.

## Safety Rules

- Never `git add -A` / `git add .` — always add explicit paths per group.
- Never `--amend`, `--no-verify`, or bypass signing.
- Never guess on possible secrets (`.env`, `*.pem`, `*.key`, hardcoded tokens) — stop and ask.
- Never delete suspected generated artifacts — exclude them from commits and propose a
  `.gitignore` entry instead.
- If a single file's diff visibly mixes two unrelated scopes, don't auto-split by hunk —
  flag it and ask.
- Never `git push` — this skill's scope ends at leaving the commits created locally.

## Validation

Every drafted commit message is validated with the same
`scripts/validate-commit-message.sh` used by the `commit-message` skill before it's
committed:

```bash
bash scripts/validate-commit-message.sh "feat(demo): add instance launcher"
```

Run the test suite:

```bash
bash tests/validate-commit-message.test.sh
```

## Documentation

- [SKILL.md](SKILL.md) - Full skill workflow and instructions
- [Conventional Commits](https://www.conventionalcommits.org/) - Commit format specification

## License

MIT

## Author

Jonathan Delgado <hi@jon.soy> (https://jon.soy)
