#!/usr/bin/env bun
/**
 * Packs dist/ as the publishable tarball: runs `bun run build` for a fresh
 * dist/ (with its own dist/package.json, see scripts/build.ts), then runs
 * `bun pm pack` *inside* dist/ so the tarball's root is dist/ itself — the
 * same artifact `npm publish` would produce from dist/ directly — and moves
 * the resulting .tgz to the repo root.
 */
import { $ } from "bun";
import { rename, stat } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
process.chdir(repoRoot);

console.log("== build ==");
await $`bun run build`;

console.log("== pack ==");
const packOutput = await $`bun pm pack`.cwd(join(repoRoot, "dist")).text();

const tarballName = packOutput
  .split("\n")
  .map((line) => line.trim())
  .findLast((line) => line.endsWith(".tgz"));
if (!tarballName) {
  throw new Error(`Could not determine tarball name from pack output:\n${packOutput}`);
}

const from = join(repoRoot, "dist", tarballName);
const to = join(repoRoot, tarballName);
await rename(from, to);

const size = (await stat(to)).size;
console.log(`\n${tarballName} (${(size / 1024).toFixed(2)} KB) -> ${to}`);
