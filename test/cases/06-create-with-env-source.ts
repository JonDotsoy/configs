// Case: envSource + mapKey.snakeCase, against an explicit `env` object
// (rather than process.env) so the same script runs unmodified in a browser,
// which has no process.env.
import { configs, envSource, mapKey } from "@jondotsoy/configs";

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

const source = envSource({
  env: { SERVER_PORT: "8080", SERVER_HOST: "example.com", UNRELATED: "ignored-key-shape" },
  mapKey: mapKey.snakeCase(),
});

const cfg = await configs.create(
  { server: configs.create({ port: { type: "number" }, host: { type: "string" } }) },
  { sources: [source] },
);

assert(cfg.server.port.get() === 8080, "SERVER_PORT maps to server.port via snakeCase");
assert(cfg.server.host.get() === "example.com", "SERVER_HOST maps to server.host via snakeCase");

await cfg.close();
console.log("ALL_CHECKS_PASSED");
