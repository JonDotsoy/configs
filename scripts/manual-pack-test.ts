#!/usr/bin/env bun
/**
 * Manual test: builds the package, runs `bun pm pack`, installs the resulting
 * tarball into a scratch temp dir, and verifies that both the root entry
 * point and every `datasources/*` subpath actually resolve and work when
 * consumed like a real npm package (not via workspace/source resolution).
 *
 * Usage: bun run scripts/manual-pack-test.ts
 */
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;

const MANUAL_TEST_SOURCE = `
import { configs, envDataSource, envKeyToPath, DataSource, ConfigError } from "@jondotsoy/configs";
import { envDataSource as envDataSource2 } from "@jondotsoy/configs/datasources/env";
import { fetchDataSource } from "@jondotsoy/configs/datasources/fetch";
import { sseDataSource } from "@jondotsoy/configs/datasources/sse";

function assert(cond, message) {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

assert(typeof configs.create === "function", "configs.create is a function");
assert(typeof envDataSource === "function", "envDataSource exported from root");
assert(typeof envKeyToPath === "function", "envKeyToPath exported from root");
assert(typeof DataSource === "function", "DataSource exported from root");
assert(typeof ConfigError === "function", "ConfigError exported from root");
assert(typeof envDataSource2 === "function", "envDataSource exported from /datasources/env");
assert(typeof fetchDataSource === "function", "fetchDataSource exported from /datasources/fetch");
assert(typeof sseDataSource === "function", "sseDataSource exported from /datasources/sse");

const source = envDataSource({ mapKey: envKeyToPath });
const cfg = await configs.create(
  { server: configs.create({ port: { type: "number", summary: "HTTP port", default: 3000 } }) },
  { datasources: [source] },
);

assert(cfg.server.port.get() === 4000, "cfg.server.port.get() reads SERVER_PORT=4000 via envDataSource");

await cfg.close();
console.log("\\nAll manual import checks passed.");
`;

console.log("== build ==");
await $`bun run build`.cwd(repoRoot);

console.log("== pack ==");
const packOutput = await $`bun pm pack`.cwd(repoRoot).text();
const tarballName = packOutput
  .split("\n")
  .map((line) => line.trim())
  .findLast((line) => line.endsWith(".tgz"));
if (!tarballName) {
  throw new Error(`Could not determine tarball name from pack output:\n${packOutput}`);
}
const tarballPath = join(repoRoot, tarballName);

console.log("== checking packed files ==");
// Anything npm/bun always includes regardless of "files", plus everything under dist/.
const allowedRootFiles = new Set(["package.json", "README.md", "LICENSE"]);
const tarEntries = (await $`tar -tzf ${tarballPath}`.text())
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((entry) => entry.replace(/^package\//, ""));

const strayFiles = tarEntries.filter(
  (entry) => !entry.startsWith("dist/") && !allowedRootFiles.has(entry),
);
if (strayFiles.length > 0) {
  throw new Error(`Unexpected files leaked into the package tarball:\n${strayFiles.join("\n")}`);
}
console.log(`ok - tarball only contains dist/ and ${[...allowedRootFiles].join(", ")}`);

const workDir = await mkdtemp(join(tmpdir(), "configs-manual-test-"));
console.log(`== installing tarball in ${workDir} ==`);

try {
  await Bun.write(
    join(workDir, "package.json"),
    JSON.stringify({ name: "manual-test-configs", module: "test.ts", type: "module", private: true }, null, 2),
  );
  await $`bun add ${tarballPath}`.cwd(workDir);

  const testFile = join(workDir, "test.ts");
  await Bun.write(testFile, MANUAL_TEST_SOURCE);

  console.log("== running import checks ==");
  await $`bun run ${testFile}`.cwd(workDir).env({ ...process.env, SERVER_PORT: "4000" });

  console.log("\nManual pack test passed.");
} finally {
  await rm(tarballPath, { force: true });
  await rm(workDir, { recursive: true, force: true });
}
