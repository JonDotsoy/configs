// Case: a `"shape"` field with a custom `Parseable` schema. Fields resolve
// lazily on first access — so a failed `required: true` field throws the
// moment it's *read* (not when `configs.create()` itself resolves), while
// the same failure on `required: false` is logged (via console.error) and
// swallowed into `null` instead. No validation library needed: `Parseable<T>`
// is just duck-typed as `{ parse(value: unknown): T }`.
import { configs, literalSource } from "@jondotsoy/configs";

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

const badSource = literalSource({ port: "not-a-number" });

const cfg1 = await configs.create({ port: { schema: numberSchema, required: true } }, { sources: [badSource] });
let threw = false;
try {
  cfg1.port.get();
} catch {
  threw = true;
}
assert(threw, "reading a required shape field throws once its schema fails to parse the source value");

const originalConsoleError = console.error;
console.error = () => {};
let cfg2Value: number | null;
try {
  const cfg2 = await configs.create({ port: { schema: numberSchema, required: false } }, { sources: [badSource] });
  cfg2Value = cfg2.port.get();
} finally {
  console.error = originalConsoleError;
}
assert(cfg2Value === null, "the same failure on a non-required shape field is swallowed into null instead");

await cfg1.close();
console.log("ALL_CHECKS_PASSED");
