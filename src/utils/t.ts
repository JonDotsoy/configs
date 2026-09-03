export type TResult<T> = [ok: true, err: null, result: T] | [ok: false, err: unknown, result: null];

/**
 * Runs `handler` (a `Promise`, a sync value/error-throwing function, or an async function) and
 * always resolves instead of rejecting: `[true, null, result]` on success, `[false, err, null]`
 * on failure — a Go-style tuple so callers can destructure without a `try`/`catch`.
 */
export async function t<T>(handler: Promise<T> | (() => Promise<T> | T)): Promise<TResult<T>> {
  try {
    const result = await (typeof handler === "function" ? handler() : handler);
    return [true, null, result];
  } catch (err) {
    return [false, err, null];
  }
}

/** Synchronous counterpart to `t()`, for a `handler` that never returns a `Promise` — same tuple, no `await`. */
export function tSync<T>(handler: () => T): TResult<T> {
  try {
    return [true, null, handler()];
  } catch (err) {
    return [false, err, null];
  }
}
