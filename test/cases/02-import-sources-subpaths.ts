// Case: every browser-safe `sources/*` subpath resolves and exports its
// factory function. `sources/file` and `sources/shell` are excluded here —
// they need `node:fs`/`node:child_process`, so each has its own case (03,
// 16) that exercises real behavior instead of just an import check.
import { envSource } from "hotconfigs/sources/env";
import { fetchSource } from "hotconfigs/sources/fetch";
import { sseSource } from "hotconfigs/sources/sse";
import { literalSource } from "hotconfigs/sources/literal";
import { pullSource } from "hotconfigs/sources/pull";
import { Source } from "hotconfigs/sources/source";

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

assert(typeof envSource === "function", "envSource exported from sources/env");
assert(typeof fetchSource === "function", "fetchSource exported from sources/fetch");
assert(typeof sseSource === "function", "sseSource exported from sources/sse");
assert(typeof literalSource === "function", "literalSource exported from sources/literal");
assert(typeof pullSource === "function", "pullSource exported from sources/pull");
assert(typeof Source === "function", "Source exported from sources/source");

console.log("ALL_CHECKS_PASSED");
