// Case: a `Source` with `reduce` — `start` hands partial patches to
// `control.set`, and `reduce(incoming, previous)`'s return value is what
// actually gets published (`previous` is `null` before the first call).
import { Source } from "hotconfigs";

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

type Patch = Record<string, unknown>;

const source = new Source<Patch>({
  reduce: (incoming, previous) => ({ ...(previous ?? {}), ...incoming }),
  start(control) {
    control.set({ a: 1 });
    control.set({ b: 2 });
  },
});

const store = await source.open();
assert(store.get()?.a === 1, "the first patch is applied through reduce (previous is null)");
assert(store.get()?.b === 2, "the second patch merges onto the previously published value");

await source.close();
console.log("ALL_CHECKS_PASSED");
