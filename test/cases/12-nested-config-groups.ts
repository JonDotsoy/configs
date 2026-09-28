// Case: nested config groups — plain nested objects in create()'s shape,
// several levels deep — resolve fields at every depth from the same source.
import { create, string } from "hotconfigs";
import { literalSource } from "hotconfigs/sources/literal";

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

const source = literalSource({ database: { host: "db.internal", credentials: { user: "root" } } });

const cfg = await create(
  {
    database: {
      host: string(),
      credentials: { user: string() },
    },
  },
  { sources: [source] },
);

assert(cfg.database.host.get() === "db.internal", "a first-level nested field resolves");
assert(cfg.database.credentials.user.get() === "root", "a second-level nested field resolves");

await source.close();
console.log("ALL_CHECKS_PASSED");
