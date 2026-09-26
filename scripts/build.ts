#!/usr/bin/env bun
/**
 * Builds dist/: bundles every public entry point (read from package.json's
 * "exports" map, one "_entryPoint" per subpath, so that map stays the single
 * source of truth for what gets built), emits .d.ts via tsc, and writes a
 * trimmed dist/package.json so dist/ is a self-contained, publishable
 * package on its own (no dist/-prefixed paths, no dev-only metadata).
 *
 * Replaces the old scripts/build.sh + `bun -e` entry-point extraction with a
 * single typed script; behavior (bundling, --external react, build:types) is
 * unchanged, plus --minify for smaller published output.
 */
import { $ } from "bun";
import { rm } from "node:fs/promises";

const repoRoot = new URL("..", import.meta.url).pathname;
process.chdir(repoRoot);

type ExportEntry = { _entryPoint: string; types: string; import: string };

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
  exports: Record<string, ExportEntry>;
};

await rm("dist", { recursive: true, force: true });

const entryPoints = Object.values(pkg.exports).map((e) => e._entryPoint);

await $`bun build ${entryPoints} --outdir dist --root src --target node --format esm --external react --minify`;
await $`bun run build:types`;

// dist/ ships as its own package: exports point at files relative to dist/
// itself (no "dist/" prefix), and only publish-relevant fields are kept.
const distExports = Object.fromEntries(
  Object.entries(pkg.exports).map(([subpath, entry]) => [
    subpath,
    {
      types: entry.types.replace(/^\.\/dist\//, "./"),
      import: entry.import.replace(/^\.\/dist\//, "./"),
    },
  ]),
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
