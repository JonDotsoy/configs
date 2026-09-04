// Case: configs.create() + literalSource — the simplest end-to-end path:
// a source that publishes once, a leaf field reading it, then a clean close.
import { configs, literalSource } from "@jondotsoy/configs";

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

const source = literalSource({ port: 4321, host: "10.0.0.1" });
const cfg = await configs.create(
  {
    port: { type: "number" },
    host: { type: "string" },
  },
  { sources: [source] },
);

assert(cfg.port.get() === 4321, "cfg.port.get() reads the literal value");
assert(cfg.host.get() === "10.0.0.1", "cfg.host.get() reads the literal value");

await cfg.close();
assert(true, "cfg.close() resolves without throwing");

console.log("ALL_CHECKS_PASSED");
