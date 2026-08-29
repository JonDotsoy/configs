import { Source } from "./source.js";

export interface PullSourceOptions<T = unknown> {
  /** Called on every round to produce a fresh snapshot. May be sync or async. */
  pull: () => T | Promise<T>;
  /** Milliseconds between calls to `pull`. */
  interval: number;
}

/** Runs one `pull()` call, logging and swallowing any failure into `undefined`. */
async function pullRound<T>(pull: () => T | Promise<T>): Promise<{ data: T } | undefined> {
  try {
    return { data: await pull() };
  } catch (error) {
    console.error("pullSource: `pull` threw", error);
    return undefined;
  }
}

/**
 * A `Source` that calls `pull` on a fixed `interval` (in milliseconds) and publishes whatever it
 * returns as the next config tree snapshot. `pull` is called once immediately when the source
 * starts, then again every `interval` milliseconds until the `Source` is closed.
 *
 * A `pull` failure is logged via `console.error` and swallowed instead of thrown. If the very
 * first call fails, the source closes with an empty (`null`) store, same as `fetchSource`. A
 * failure on a later round is logged and skipped, keeping the last good value and the polling
 * running.
 */
export function pullSource<T = unknown>(options: PullSourceOptions<T>): Source<T> {
  const { pull, interval } = options;
  let timer: ReturnType<typeof setTimeout> | undefined;

  return new Source<T>({
    async start(control) {
      const first = await pullRound(pull);
      if (!first) {
        control.close();
        return;
      }

      control.set(first.data);

      const scheduleNext = () => {
        timer = setTimeout(async () => {
          const result = await pullRound(pull);
          if (result) control.set(result.data);
          scheduleNext();
        }, interval);
      };
      scheduleNext();
    },
    close() {
      clearTimeout(timer);
    },
  });
}
