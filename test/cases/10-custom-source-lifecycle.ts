// Case: a hand-rolled `Source` — `start(control)` pushing more than one
// snapshot, and `close()` releasing what `start` set up.
import { Source } from "hotconfigs";

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

let closed: boolean = false;
let timer: ReturnType<typeof setTimeout> | undefined;

const source = new Source<{ ready: boolean }>({
  start(control) {
    control.set({ ready: false });
    timer = setTimeout(() => control.set({ ready: true }), 10);
  },
  close() {
    closed = true;
    clearTimeout(timer);
  },
});

const store = await source.open();
assert(store.get()?.ready === false, "the store holds the first snapshot once open() resolves");

await new Promise((resolve) => setTimeout(resolve, 30));
assert(store.get()?.ready === true, "a later control.set() call updates the same store live");

await source.close();
assert(closed, "close() runs the underlying close() hook");

await source.close();
assert(closed, "close() is safe to call more than once");

console.log("ALL_CHECKS_PASSED");
