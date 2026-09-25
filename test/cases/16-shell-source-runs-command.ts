// Case: shellSource runs a command via node:child_process's spawn and
// publishes its parsed stdout as the config tree. node:child_process-backed,
// so a browser bundle stubs it out (see manifest.ts's tolerateFailureEngines
// for this case) — run there anyway to document the breakage instead of
// skipping it, same as fileSource's node:fs case (15).
import { create, shellSource, numeric } from "@jondotsoy/configs";

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

const source = shellSource<{ port: number }>(["echo", JSON.stringify({ port: 7070 })]);
const cfg = await create({ port: numeric() }, { sources: [source] });

assert(cfg.port.get() === 7070, "shellSource runs a command and parses its stdout as JSON");

await source.close();
console.log("ALL_CHECKS_PASSED");
