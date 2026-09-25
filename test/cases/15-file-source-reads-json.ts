// Case: fileSource reads a real JSON file from disk once (`watch: false`)
// and publishes it as the config tree. node:fs-backed — under a browser
// bundle, node:fs/promises is stubbed out and this fails (see manifest.ts's
// tolerateFailureEngines for this case: it still runs there, but a failure
// is expected and reported as a WARNING, not a FAILED).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fileSource, numeric } from "@jondotsoy/configs";

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

const dir = await mkdtemp(join(tmpdir(), "configs-file-source-case-"));
const filePath = join(dir, "config.json");

try {
  await writeFile(filePath, JSON.stringify({ port: 6060 }));

  const source = fileSource<{ port: number }>(filePath, { watch: false });
  const cfg = await create({ port: numeric() }, { sources: [source] });

  assert(cfg.port.get() === 6060, "fileSource reads and parses a JSON file from disk");

  await source.close();
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("ALL_CHECKS_PASSED");
