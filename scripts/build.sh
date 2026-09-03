#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

rm -rf dist

# Entry points come from each export's "_entryPoint" in package.json, so the
# export map stays the single source of truth for what gets built.
mapfile -t entry_points < <(bun -e '
  const { exports } = await Bun.file("package.json").json();
  for (const value of Object.values(exports)) console.log(value._entryPoint);
')

bun build "${entry_points[@]}" \
  --outdir dist \
  --root src \
  --target node \
  --format esm \
  --external react
bun run build:types
