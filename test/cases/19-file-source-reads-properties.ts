// Case: fileSource reads a real .properties file from disk once (`watch:
// false`), nesting dotted keys into the config tree, and publishes it —
// node:fs-backed, so a browser bundle stubs it out (see manifest.ts's
// tolerateFailureEngines for this case: it still runs there, but a failure
// is expected and reported as a WARNING, not a FAILED).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, numeric, string } from "hotconfigs";
import { fileSource } from "hotconfigs/sources/file";

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

const dir = await mkdtemp(join(tmpdir(), "configs-properties-source-case-"));
const filePath = join(dir, "config.properties");

try {
  await writeFile(
    filePath,
    "game.initial-score=30\nplayers.default-name=default\n",
  );

  const source = fileSource(filePath, { watch: false });
  const cfg = await create(
    {
      game: { "initial-score": numeric() },
      players: { "default-name": string() },
    },
    { sources: [source] },
  );

  assert(cfg.game["initial-score"].get() === 30, "fileSource reads and parses a .properties file's nested numeric field");
  assert(
    cfg.players["default-name"].get() === "default",
    "fileSource reads and parses a .properties file's nested string field",
  );

  await source.close();
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("ALL_CHECKS_PASSED");
