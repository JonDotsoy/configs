// Case: a shape() field with a custom Parseable schema. Fields resolve
// eagerly and reactively — so a failed `required: true` field rejects the
// awaited create() call itself (thrown as soon as the bad value is parsed,
// not deferred to whenever the field is next read), while the same failure
// on `required: false` is logged (via console.error) and swallowed into
// `null` instead. No validation library needed: `Parseable<T>` is just
// duck-typed as `{ parse(value: unknown): T }`.
import { create, literalSource, shape } from "@jondotsoy/configs";

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

const numberSchema = {
  parse(value: unknown): number {
    if (typeof value !== "number") throw new Error("expected a number");
    return value;
  },
};

const badSource1 = literalSource({ port: "not-a-number" });

let threw = false;
try {
  await create({ port: shape({ schema: numberSchema, required: true }) }, { sources: [badSource1] });
} catch {
  threw = true;
}
assert(threw, "awaiting create() rejects once a required shape field fails to parse the source value");

const originalConsoleError = console.error;
console.error = () => {};
let cfg2Value: number | null;
const badSource2 = literalSource({ port: "not-a-number" });
try {
  const cfg2 = await create({ port: shape({ schema: numberSchema, required: false }) }, { sources: [badSource2] });
  cfg2Value = cfg2.port.get();
} finally {
  console.error = originalConsoleError;
}
assert(cfg2Value === null, "the same failure on a non-required shape field is swallowed into null instead");

await badSource1.close();
await badSource2.close();
console.log("ALL_CHECKS_PASSED");
