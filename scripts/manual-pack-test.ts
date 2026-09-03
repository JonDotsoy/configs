#!/usr/bin/env bun
/**
 * Manual test: builds the package, runs `bun pm pack`, installs the resulting
 * tarball into a scratch temp dir, and verifies that both the root entry
 * point and every `sources/*` subpath actually resolve and work when
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
import { configs, envSource, literalSource, mapKey, Source, ConfigError } from "@jondotsoy/configs";
import { envSource as envSource2 } from "@jondotsoy/configs/sources/env";
import { fetchSource } from "@jondotsoy/configs/sources/fetch";
import { sseSource } from "@jondotsoy/configs/sources/sse";
import { useConfig } from "@jondotsoy/configs/react";
import { CounterMetric, GaugeMetric, HistogramMetric, SummaryMetric } from "@jondotsoy/configs/utils/metrics";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

function assert(cond, message) {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

assert(typeof configs.create === "function", "configs.create is a function");
assert(typeof envSource === "function", "envSource exported from root");
assert(typeof mapKey.snakeCase === "function", "mapKey.snakeCase exported from root");
assert(typeof literalSource === "function", "literalSource exported from root");
assert(typeof Source === "function", "Source exported from root");
assert(typeof ConfigError === "function", "ConfigError exported from root");
assert(typeof envSource2 === "function", "envSource exported from /sources/env");
assert(typeof fetchSource === "function", "fetchSource exported from /sources/fetch");
assert(typeof sseSource === "function", "sseSource exported from /sources/sse");
assert(typeof CounterMetric === "function", "CounterMetric exported from /utils/metrics");
assert(typeof GaugeMetric === "function", "GaugeMetric exported from /utils/metrics");
assert(typeof HistogramMetric === "function", "HistogramMetric exported from /utils/metrics");
assert(typeof SummaryMetric === "function", "SummaryMetric exported from /utils/metrics");

const requests = new CounterMetric({ name: "requests_total" });
requests.inc();
assert(requests.get() === 1, "CounterMetric.inc()/get() work via /utils/metrics");

const source = envSource({ mapKey: mapKey.snakeCase() });
const cfg = await configs.create(
  { server: configs.create({ port: { type: "number", summary: "HTTP port", default: 3000 } }) },
  { sources: [source] },
);

assert(cfg.server.port.get() === 4000, "cfg.server.port.get() reads SERVER_PORT=4000 via envSource");

assert(typeof useConfig === "function", "useConfig exported from /react");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const bannerSource = literalSource({ bannerIsActive: true });
const bannerCfg = await configs.create(
  { bannerIsActive: { type: "boolean", required: true } },
  { sources: [bannerSource] },
);

let renderedValue;
function Reader() {
  renderedValue = useConfig(bannerCfg.bannerIsActive);
  return null;
}
act(() => {
  TestRenderer.create(React.createElement(Reader));
});
assert(renderedValue === true, "useConfig reads the live value from a config field");

await cfg.close();
await bannerCfg.close();
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
  (entry) => !entry.startsWith("dist/") && !entry.startsWith("docs/") && !allowedRootFiles.has(entry),
);
if (strayFiles.length > 0) {
  throw new Error(`Unexpected files leaked into the package tarball:\n${strayFiles.join("\n")}`);
}
console.log(`ok - tarball only contains dist/, docs/, and ${[...allowedRootFiles].join(", ")}`);

const workDir = await mkdtemp(join(tmpdir(), "configs-manual-test-"));
console.log(`== installing tarball in ${workDir} ==`);

try {
  await Bun.write(
    join(workDir, "package.json"),
    JSON.stringify({ name: "manual-test-configs", module: "test.ts", type: "module", private: true }, null, 2),
  );
  await $`bun add ${tarballPath} react react-test-renderer`.cwd(workDir);

  const testFile = join(workDir, "test.ts");
  await Bun.write(testFile, MANUAL_TEST_SOURCE);

  console.log("== running import checks ==");
  await $`bun run ${testFile}`.cwd(workDir).env({ ...process.env, SERVER_PORT: "4000" });

  console.log("\nManual pack test passed.");
} finally {
  await rm(tarballPath, { force: true });
  await rm(workDir, { recursive: true, force: true });
}
