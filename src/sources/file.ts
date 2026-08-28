import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { Source } from "./source";
import { DotEnv } from "../utils/dotenv";

export interface FileSourceOptions {
  /** Republishes the config tree whenever the file changes on disk. Defaults to `true`. */
  watch?: boolean;
  /**
   * Selects a subtree of the parsed file to use as the config tree, e.g. `["containers", "settings"]`
   * to use `{ containers: { settings: {...} } }`'s inner object and ignore the rest of the file.
   * Defaults to `[]`: the whole parsed file is used, unchanged.
   */
  treePath?: string[];
}

type FileFormat = "json" | "env";

/** Picks a parser from the path's extension; a bare `.env` (no basename) counts as `.env` too. */
function detectFormat(path: string | URL): FileFormat | undefined {
  const pathname = path instanceof URL ? path.pathname : path;
  if (pathname.endsWith(".json")) return "json";
  if (pathname.endsWith(".env")) return "env";
  return undefined;
}

function parseFile(format: FileFormat, text: string): unknown {
  switch (format) {
    case "json":
      return JSON.parse(text);
    case "env":
      return DotEnv.parse(text);
  }
}

/** Walks `treePath` into `data`, one key per segment. `undefined` means the path doesn't resolve — either a missing key, or an intermediate segment that isn't an object. */
function selectTreePath(data: unknown, treePath: string[]): unknown {
  let node = data;
  for (const key of treePath) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * A `Source` that reads a config tree from a local file — `.json` or `.env` (matched by
 * `path`'s extension, or by the bare `.env` filename itself). `path` may be a plain string or a
 * `file:` `URL` (e.g. `import.meta.resolve(...)` or `new URL("./config.json", import.meta.url)`).
 * Like `fetchSource` and `sseSource`, a read or parse failure is logged via `console.error` and
 * leaves the store empty (`null`) instead of throwing.
 *
 * `treePath` selects a subtree of the parsed file to use, instead of the whole thing. A missing
 * or non-object segment along the way is logged via `console.error`, same as a parse failure —
 * but unlike one, it still publishes a snapshot: an empty object (`{}`), not `null` / the last
 * good value, since the file itself was read and parsed fine.
 *
 * With `watch` (the default), the file is re-read on every change and the store updated live; a
 * parse error on one of those later reads is logged but keeps the last good value, same as
 * `sseSource` does for a bad SSE message. `watch: false` reads the file once and closes.
 */
export function fileSource<T = unknown>(
  path: string | URL,
  options: FileSourceOptions = {},
): Source<T> {
  const shouldWatch = options.watch ?? true;
  const treePath = options.treePath ?? [];
  let watcher: FSWatcher | undefined;

  return new Source<T>({
    async start(control) {
      const format = detectFormat(path);
      if (!format) {
        console.error(`fileSource: unrecognized file extension for "${path}"`);
        control.close();
        return;
      }

      async function readOnce(): Promise<boolean> {
        let text: string;
        try {
          text = await readFile(path, "utf8");
        } catch (error) {
          console.error(`fileSource: failed to read "${path}"`, error);
          return false;
        }

        let parsed: unknown;
        try {
          parsed = parseFile(format!, text);
        } catch (error) {
          console.error(`fileSource: failed to parse "${path}" as ${format}`, error);
          return false;
        }

        const selected = selectTreePath(parsed, treePath);
        if (selected === undefined) {
          console.error(
            `fileSource: treePath [${treePath.map((k) => JSON.stringify(k)).join(", ")}] did not resolve to anything in "${path}"`,
          );
          control.set({} as T);
          return true;
        }

        control.set(selected as T);
        return true;
      }

      await readOnce();

      if (!shouldWatch) {
        control.close();
        return;
      }

      watcher = watch(path, { persistent: false }, () => {
        void readOnce();
      });
    },
    close() {
      watcher?.close();
    },
  });
}
