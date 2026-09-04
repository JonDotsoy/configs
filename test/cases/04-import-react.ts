// Case: the `/react` subpath resolves and exports `useConfig`, with the
// `react` peer dependency itself resolvable alongside it.
import { useConfig } from "@jondotsoy/configs/react";

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

assert(typeof useConfig === "function", "useConfig exported from /react");

console.log("ALL_CHECKS_PASSED");
