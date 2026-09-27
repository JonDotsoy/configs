#!/usr/bin/env bun
/**
 * Builds dist/: transpiles every `src/*.ts` module (one file in, one
 * `.js`/`.d.ts` pair out, via `tsc -p tsconfig.build.json` — no bundling, no
 * minification) and writes a trimmed dist/package.json — with its own
 * "exports" map derived from package.json's "_buildEntripoint" (one
 * `src/*.ts` path per public subpath, so that map stays the single source of
 * truth for what's public) — so dist/ is a self-contained, publishable
 * package on its own (no dist/-prefixed paths, no dev-only metadata). The
 * root package.json is "private": true and carries no "exports" of its own;
 * dist/package.json is the only manifest ever published. README.md, LICENSE,
 * and docs/ are copied in alongside it, so the published package still
 * carries them (npm's registry page reads README.md straight from the
 * published package root).
 *
 * `tsc` mirrors src/'s own module graph 1:1 into dist/ — every module keeps
 * its own file, importing its siblings by the same relative `.js` specifiers
 * already written in `src/*.ts` (see AGENTS.md's "Internal imports use
 * explicit .js extensions" — `tsc` copies those specifiers through emit
 * verbatim, so they resolve dist-side without any rewriting here). That
 * means a class like `Descriptor` (`config-descriptor.ts`) exists as exactly
 * one module, imported by reference everywhere else in the published
 * package — unlike a bundler, which would inline a separate copy of it into
 * every entry point's own bundle. Trades away bundling/minification (a
 * published `dist/` is now many small files instead of one bundle per entry
 * point) for that single-source-of-truth guarantee.
 */
import { $ } from "bun";
import { cp, rm } from "node:fs/promises";

const repoRoot = new URL("..", import.meta.url).pathname;
process.chdir(repoRoot);

const pkg = (await Bun.file("package.json").json()) as {
  name: string;
  version: string;
  description: string;
  type: string;
  sideEffects: boolean;
  license: string;
  author: unknown;
  homepage: string;
  repository: unknown;
  bugs: unknown;
  peerDependencies: unknown;
  peerDependenciesMeta: unknown;
  _buildEntripoint: Record<string, string>;
};

await rm("dist", { recursive: true, force: true });

await $`bun run build:tsc`;

/** "./src/sources/env.ts" -> "sources/env" — the path tsc emits under dist/, relative to dist/ itself. */
function distBasename(srcPath: string): string {
  return srcPath.replace(/^\.\/src\//, "").replace(/\.ts$/, "");
}

// dist/ ships as its own package: exports point at files relative to dist/
// itself, derived from _buildEntripoint's src/*.ts paths.
const distExports = Object.fromEntries(
  Object.entries(pkg._buildEntripoint).map(([subpath, srcPath]) => {
    const basename = distBasename(srcPath);
    return [subpath, { types: `./${basename}.d.ts`, import: `./${basename}.js` }];
  }),
);

const distPackageJson = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  type: pkg.type,
  sideEffects: pkg.sideEffects,
  license: pkg.license,
  author: pkg.author,
  homepage: pkg.homepage,
  repository: pkg.repository,
  bugs: pkg.bugs,
  exports: distExports,
  peerDependencies: pkg.peerDependencies,
  peerDependenciesMeta: pkg.peerDependenciesMeta,
};

await Bun.write("dist/package.json", `${JSON.stringify(distPackageJson, null, 2)}\n`);

await cp("README.md", "dist/README.md");
await cp("LICENSE", "dist/LICENSE");
await cp("docs", "dist/docs", { recursive: true });
