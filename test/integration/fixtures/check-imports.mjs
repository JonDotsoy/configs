// Runtime-agnostic fixture: exercises every public import path of the built
// package (@jondotsoy/configs and each sources/* subpath) under a real
// installed copy — not source resolution. Run by test/integration/runtime-imports.ts
// under Node, Bun, and Deno.
import { configs, envSource, mapKey, Source, ConfigError } from "@jondotsoy/configs";
import { envSource as envSourceFromSubpath } from "@jondotsoy/configs/sources/env";
import { fetchSource } from "@jondotsoy/configs/sources/fetch";
import { sseSource } from "@jondotsoy/configs/sources/sse";

function assert(cond, message) {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

assert(typeof configs.create === "function", "configs.create is a function");
assert(typeof envSource === "function", "envSource exported from root");
assert(typeof mapKey.snakeCase === "function", "mapKey.snakeCase exported from root");
assert(typeof Source === "function", "Source exported from root");
assert(typeof ConfigError === "function", "ConfigError exported from root");
assert(typeof envSourceFromSubpath === "function", "envSource exported from /sources/env");
assert(typeof fetchSource === "function", "fetchSource exported from /sources/fetch");
assert(typeof sseSource === "function", "sseSource exported from /sources/sse");

const source = envSource({ mapKey: mapKey.snakeCase() });
const cfg = await configs.create(
  { server: configs.create({ port: { type: "number", summary: "HTTP port", default: 3000 } }) },
  { sources: [source] },
);

assert(cfg.server.port.get() === 4000, "cfg.server.port.get() reads SERVER_PORT=4000 via envSource");

await cfg.close();
console.log("ALL_CHECKS_PASSED");
