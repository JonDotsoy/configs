/** Walks `treePath` into `data`, one key per segment. `undefined` means the path doesn't resolve — either a missing key, or an intermediate segment that isn't an object. */
export function selectTreePath(data: unknown, treePath: string[]): unknown {
  let node = data;
  for (const key of treePath) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}
