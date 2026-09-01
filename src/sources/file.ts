import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { Source } from "./source.js";
import { DotEnv } from "../utils/dotenv.js";
import { t } from "../utils/t.js";

export type FileFormat = "json" | "env";

export interface FileSourceOptions {
  /** Republishes the config tree whenever the file changes on disk. Defaults to `true`. */
  watch?: boolean;
  /**
   * Selects a subtree of the parsed file to use as the config tree, e.g. `["containers", "settings"]`
   * to use `{ containers: { settings: {...} } }`'s inner object and ignore the rest of the file.
   * Defaults to `[]`: the whole parsed file is used, unchanged.
   */
  treePath?: string[];
  /**
   * Picks which built-in parser to use — `"json"` or `"env"` — overriding extension-based
   * detection. Use it when `path` has no extension to detect (e.g.
   * `fileSource("./config", { format: "env" })`), or to force one format on a file named for the
   * other. Ignored when `parser` is set. Defaults to detecting `path`'s extension: `.env` for a
   * bare or `.env`-named file, `"json"` for anything else.
   */
  format?: FileFormat;
  /**
   * Overrides the default parsing: receives the file's raw bytes and returns the parsed config
   * tree. Use it for formats this module doesn't parse itself, e.g. YAML with a library of your
   * choice: `fileSource("./file.yaml", { parser: (bytes) => YAML.parse(new
   * TextDecoder().decode(bytes)) })`. Defaults to a parser that decodes the bytes as UTF-8 and
   * parses them per `format` (or, without one, `path`'s detected format).
   */
  parser?: (buffer: Uint8Array) => unknown;
}

/** Picks a format from the path's extension; a bare `.env` (no basename) counts as `.env` too. Defaults to `"json"`. */
function detectFormat(path: string | URL): FileFormat {
  const pathname = path instanceof URL ? path.pathname : path;
  if (pathname.endsWith(".env")) return "env";
  return "json";
}

function parseFile(format: FileFormat, text: string): unknown {
  switch (format) {
    case "json":
      return JSON.parse(text);
    case "env":
      return DotEnv.parse(text);
  }
}

/**
 * Decodes `buffer` as UTF-8 and parses it as `format`, or — without one — `path`'s detected
 * format (`.env`, JSON otherwise).
 */
function defaultParser(path: string | URL, format: FileFormat | undefined): (buffer: Uint8Array) => unknown {
  const resolvedFormat = format ?? detectFormat(path);
  return (buffer) => parseFile(resolvedFormat, new TextDecoder().decode(buffer));
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
 * A `Source` that reads a config tree from a local file — `.json` or `.env` by default (matched by
 * `path`'s extension, or by the bare `.env` filename itself; anything else is parsed as JSON), or
 * any format via a custom `parser` option. `path` may be a plain string or a `file:` `URL` (e.g.
 * `import.meta.resolve(...)` or `new URL("./config.json", import.meta.url)`). Like `fetchSource`
 * and `sseSource`, a read or parse failure is logged via `console.error` and leaves the store
 * empty (`null`) instead of throwing.
 *
 * `parser`, when set, overrides the default parsing entirely: it receives the file's raw bytes
 * and its return value is used as the parsed tree, which lets `fileSource` support formats like
 * YAML without a hard dependency on a YAML library:
 * `fileSource("./file.yaml", { parser: (bytes) => YAML.parse(new TextDecoder().decode(bytes)) })`.
 * `format` picks between the two built-in parsers explicitly instead of relying on `path`'s
 * extension — handy for an extensionless path like `fileSource("./config", { format: "env" })`.
 * It's ignored once `parser` is set.
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
  const parser = options.parser ?? defaultParser(path, options.format);
  let watcher: FSWatcher | undefined;

  return new Source<T>({
    async start(control) {
      async function readOnce(): Promise<boolean> {
        const [readOk, readErr, buffer] = await t(() => readFile(path));
        if (!readOk) {
          console.error(`fileSource: failed to read "${path}"`, readErr);
          return false;
        }

        const [parseOk, parseErr, parsed] = await t(() => parser(buffer));
        if (!parseOk) {
          console.error(`fileSource: failed to parse "${path}"`, parseErr);
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
