// Case: importing the root entry point (`hotconfigs`) exposes every
// documented top-level export, under every supported engine.
import {
  create,
  load,
  envSource,
  fetchSource,
  fileSource,
  literalSource,
  mapKey,
  pullSource,
  sseSource,
  Source,
  Store,
  ConfigError,
} from "hotconfigs";

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

assert(typeof create === "function", "create is exported from root");
assert(typeof load === "function", "load is exported from root");
assert(typeof envSource === "function", "envSource is exported from root");
assert(typeof fetchSource === "function", "fetchSource is exported from root");
assert(typeof fileSource === "function", "fileSource is exported from root");
assert(typeof literalSource === "function", "literalSource is exported from root");
assert(typeof pullSource === "function", "pullSource is exported from root");
assert(typeof sseSource === "function", "sseSource is exported from root");
assert(typeof Source === "function", "Source is exported from root");
assert(typeof Store === "function", "Store is exported from root");
assert(typeof ConfigError === "function", "ConfigError is exported from root");
assert(typeof mapKey.snakeCase === "function", "mapKey.snakeCase is exported from root");
assert(typeof mapKey.camelCase === "function", "mapKey.camelCase is exported from root");
assert(typeof mapKey.identity === "function", "mapKey.identity is exported from root");
assert(typeof mapKey.lookup === "function", "mapKey.lookup is exported from root");

console.log("ALL_CHECKS_PASSED");
