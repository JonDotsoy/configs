// Case: pullSource calls `pull` immediately, then again every `interval` ms,
// until the source is closed.
import { create, numeric } from "hotconfigs";
import { pullSource } from "hotconfigs/sources/pull";

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

let rounds = 0;
const source = pullSource({
  pull: () => {
    rounds++;
    return { rounds };
  },
  interval: 10,
});

const cfg = await create({ rounds: numeric() }, { sources: [source] });

assert(cfg.rounds.get() === 1, "the first pull() round runs before create() resolves");

await new Promise((resolve) => setTimeout(resolve, 50));
assert(cfg.rounds.get()! >= 2, "later rounds keep polling on the given interval");

await source.close();
const afterClose = cfg.rounds.get();
await new Promise((resolve) => setTimeout(resolve, 50));
assert(cfg.rounds.get() === afterClose, "close() stops further polling");

console.log("ALL_CHECKS_PASSED");
