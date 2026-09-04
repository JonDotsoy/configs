// Case: every built-in `mapKey` strategy, exercised directly as pure
// functions — no I/O, so this doubles as a baseline "does plain JS run here"
// sanity check across engines.
import { mapKey } from "@jondotsoy/configs";

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

assert(
  JSON.stringify(mapKey.snakeCase()("FOO_TAR")) === JSON.stringify(["foo", "tar"]),
  "mapKey.snakeCase splits on underscore",
);
assert(
  JSON.stringify(mapKey.snakeCase({ separator: "__" })("API_KEY__V2")) === JSON.stringify(["api_key", "v2"]),
  "mapKey.snakeCase honors a custom separator",
);
assert(
  JSON.stringify(mapKey.identity()("FOO_TAR")) === JSON.stringify(["FOO_TAR"]),
  "mapKey.identity keeps the key as a single segment",
);
assert(
  JSON.stringify(mapKey.camelCase()("FOO_TAR")) === JSON.stringify(["fooTar"]),
  "mapKey.camelCase maps to a single camelCase segment",
);
assert(
  JSON.stringify(mapKey.lookup({ PORT: ["server", "port"] })("PORT")) === JSON.stringify(["server", "port"]),
  "mapKey.lookup maps a listed key to its explicit path",
);
assert(
  JSON.stringify(mapKey.lookup({ PORT: ["server", "port"] })("HOST")) === JSON.stringify(["HOST"]),
  "mapKey.lookup falls back to identity for an unlisted key",
);

console.log("ALL_CHECKS_PASSED");
