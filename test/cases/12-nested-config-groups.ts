// Case: nested config groups — a shape built from `configs.create()` calls
// embedded inside another `configs.create()`'s shape — resolve fields at
// every depth and close() cascades into every nested source.
import { configs, literalSource } from "@jondotsoy/configs";

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

const source = literalSource({ database: { host: "db.internal", credentials: { user: "root" } } });

const cfg = await configs.create(
  {
    database: configs.create({
      host: { type: "string" },
      credentials: configs.create({ user: { type: "string" } }),
    }),
  },
  { sources: [source] },
);

assert(cfg.database.host.get() === "db.internal", "a first-level nested field resolves");
assert(cfg.database.credentials.user.get() === "root", "a second-level nested field resolves");

await cfg.close();
console.log("ALL_CHECKS_PASSED");
