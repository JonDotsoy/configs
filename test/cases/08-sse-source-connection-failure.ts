// Case: sseSource against an address nothing listens on — documented to log
// via console.error and leave the store empty (null) instead of throwing.
// Exercised without a live SSE server so it runs identically under every
// engine, including a browser page.
import { configs, sseSource } from "@jondotsoy/configs";

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

const source = sseSource({ url: "http://127.0.0.1:9/nobody-listens-here" });
const cfg = await configs.create({ port: { type: "number" } }, { sources: [source] });

assert(cfg.port.get() === null, "a failed sseSource connection leaves the field null instead of throwing");

await cfg.close();
console.log("ALL_CHECKS_PASSED");
