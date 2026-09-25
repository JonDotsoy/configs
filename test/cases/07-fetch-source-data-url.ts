// Case: fetchSource against a `data:` URL — no server needed, so the exact
// same script exercises a real HTTP round trip (fetch + JSON parsing +
// treePath selection) under node, bun, deno, and a real browser alike.
import { create, fetchSource, numeric } from "@jondotsoy/configs";

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

const body = JSON.stringify({ app: { port: 5050 } });
const url = `data:application/json,${encodeURIComponent(body)}`;

const source = fetchSource<{ port: number }>({ url, treePath: ["app"] });
const cfg = await create({ port: numeric() }, { sources: [source] });

assert(cfg.port.get() === 5050, "fetchSource fetches a data: URL and applies treePath");

await source.close();
console.log("ALL_CHECKS_PASSED");
