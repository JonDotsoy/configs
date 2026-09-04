// Case: every browser-safe `sources/*` subpath resolves and exports its
// factory function. `sources/file` and `sources/shell` are excluded here —
// they need `node:fs`/`node:child_process`, so each has its own case (03,
// 16) that exercises real behavior instead of just an import check.
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
