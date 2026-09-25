import { useSyncExternalStore } from "react";
import type { ReadOnlyStore } from "./utils/store.js";

/** Subscribes a component to a `Store`/`ReadOnlyStore` and returns its current value, re-rendering on every update. */
export function useConfig<T>(store: ReadOnlyStore<T>): T {
  return useSyncExternalStore(
    (onStoreChange) => store.listen(onStoreChange),
    () => store.get(),
    () => store.get(),
  );
}
