// Case: `sources/file` resolves and works. It's node:fs-backed, so a browser
// bundle stubs it out (see manifest.ts's tolerateFailureEngines for this
// case) — but this case only checks the import shape, which doesn't touch
// the stub, so it actually still passes there.
import { fileSource } from "@jondotsoy/configs/sources/file";

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

assert(typeof fileSource === "function", "fileSource exported from sources/file");

console.log("ALL_CHECKS_PASSED");
