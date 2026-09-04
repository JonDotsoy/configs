// Case: every browser-safe `sources/*` subpath resolves and exports its
// factory function. `sources/file` is excluded here — it needs `node:fs`, so
// it has its own case (03) that only runs under node/bun/deno.
import { envSource } from "@jondotsoy/configs/sources/env";
import { fetchSource } from "@jondotsoy/configs/sources/fetch";
import { sseSource } from "@jondotsoy/configs/sources/sse";
import { literalSource } from "@jondotsoy/configs/sources/literal";
import { pullSource } from "@jondotsoy/configs/sources/pull";

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

assert(typeof envSource === "function", "envSource exported from sources/env");
assert(typeof fetchSource === "function", "fetchSource exported from sources/fetch");
assert(typeof sseSource === "function", "sseSource exported from sources/sse");
assert(typeof literalSource === "function", "literalSource exported from sources/literal");
assert(typeof pullSource === "function", "pullSource exported from sources/pull");

console.log("ALL_CHECKS_PASSED");
