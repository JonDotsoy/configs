#!/usr/bin/env bun
/**
 * Builds dist/: bundles every public entry point (read from package.json's
 * "_buildEntripoint" map, one `src/*.ts` path per subpath, so that map stays
 * the single source of truth for what gets built), emits .d.ts via tsc, and
 * writes a trimmed dist/package.json — with its own "exports" map derived
 * from "_buildEntripoint" — so dist/ is a self-contained, publishable
 * package on its own (no dist/-prefixed paths, no dev-only metadata). The
 * root package.json is "private": true and carries no "exports" of its own;
 * dist/package.json is the only manifest ever published.
 *
 * Replaces the old scripts/build.sh + `bun -e` entry-point extraction with a
 * single typed script; behavior (bundling, --external react, build:types) is
 * unchanged, plus --minify for smaller published output.
 */
import { $ } from "bun";
import { rm } from "node:fs/promises";

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

const entryPoints = Object.values(pkg._buildEntripoint);

await $`bun build ${entryPoints} --outdir dist --root src --target node --format esm --external react --minify`;
await $`bun run build:types`;

/** "./src/sources/env.ts" -> "sources/env" — the path bun build/tsc emit under dist/, relative to dist/ itself. */
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
