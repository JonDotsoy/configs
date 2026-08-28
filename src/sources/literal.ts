import { Source } from "./source.js";

/** A `Source` that publishes a single static `value` immediately, then closes. Useful for hardcoded defaults, a static fallback tree, or tests. */
export function literalSource<T = unknown>(value: T): Source<T> {
  return new Source<T>({
    start(control) {
      control.set(value);
      control.close();
    },
  });
}
