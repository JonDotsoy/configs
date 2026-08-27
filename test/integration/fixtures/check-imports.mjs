// Runtime-agnostic fixture: exercises every public import path of the built
// package (@jondotsoy/configs and each datasources/* subpath) under a real
// installed copy — not source resolution. Run by test/integration/runtime-imports.ts
// under Node, Bun, and Deno.
import { configs, envDataSource, envKeyToPath, DataSource, ConfigError } from "@jondotsoy/configs";
import { envDataSource as envDataSourceFromSubpath } from "@jondotsoy/configs/datasources/env";
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
assert(typeof envDataSourceFromSubpath === "function", "envDataSource exported from /datasources/env");
assert(typeof fetchDataSource === "function", "fetchDataSource exported from /datasources/fetch");
assert(typeof sseDataSource === "function", "sseDataSource exported from /datasources/sse");

const source = envDataSource({ mapKey: envKeyToPath });
const cfg = await configs.create(
  { server: configs.create({ port: { type: "number", summary: "HTTP port", default: 3000 } }) },
  { datasources: [source] },
);

assert(cfg.server.port.get() === 4000, "cfg.server.port.get() reads SERVER_PORT=4000 via envDataSource");

await cfg.close();
console.log("ALL_CHECKS_PASSED");
