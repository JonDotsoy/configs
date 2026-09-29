import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { Source } from "./source.js";
import { DotEnv } from "../utils/dotenv.js";
import { Properties } from "../utils/properties.js";
import { CounterMetric, HistogramMetric, type Metric } from "../utils/metric.js";
import { t } from "../utils/t.js";
import { selectTreePath } from "../utils/tree-path.js";

export type FileFormat = "json" | "env" | "properties";

export interface FileSourceOptions<T = unknown> {
  /**
   * Republishes the config tree whenever the file changes on disk. Defaults to `true`, using
   * `fs.watch` under the hood. `fs.watch` doesn't fire reliably on every platform/filesystem
   * (e.g. some network mounts, containers, or editors that write via rename) — pass `{ interval:
   * <ms> }` instead of `true` to poll the file every `interval` milliseconds and re-read it
   * unconditionally, rather than relying on filesystem change events. `false` reads the file once
   * and closes.
   */
  watch?: boolean | { interval: number };
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
   * bare or `.env`-named file, `"properties"` for a `.properties` file, `"json"` for anything
   * else.
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
  /**
   * Combines each read with the previously published value instead of replacing it outright.
   * Especially useful with `watch` (the default), when a later read should merge into what's
   * already there rather than replace it wholesale. Receives the freshly read (and
   * `treePath`-selected) tree as `incoming` and the last published value as `previous` (`null`
   * before the first read). Defaults to publishing `incoming` as-is — a full replace.
   */
  reduce?: (incoming: T, previous: T | null) => T;
}

/** The metrics `fileSource` records, exposed as-is on the resulting `Source` via `source.metrics`. */
type FileSourceMetrics = Record<string, Metric> & {
  /** Reads (the initial one, and every `watch`-triggered re-read), labeled `ok` (`"true"` / `"false"`). */
  reads: CounterMetric;
  /** How long each read+parse took, in seconds, labeled `ok` (`"true"` / `"false"`). */
  readDuration: HistogramMetric;
};

function createMetrics(): FileSourceMetrics {
  return {
    reads: new CounterMetric({
      name: "file_source_reads_total",
      help: "Total reads run by fileSource (initial and watch-triggered), labeled by outcome.",
      labelNames: ["ok"],
    }),
    readDuration: new HistogramMetric({
      name: "file_source_read_duration_seconds",
      help: "How long each fileSource read+parse took, in seconds, labeled by outcome.",
      labelNames: ["ok"],
    }),
  };
}

/** Picks a format from the path's extension; a bare `.env` (no basename) counts as `.env` too. Defaults to `"json"`. */
function detectFormat(path: string | URL): FileFormat {
  const pathname = path instanceof URL ? path.pathname : path;
  if (pathname.endsWith(".env")) return "env";
  if (pathname.endsWith(".properties")) return "properties";
  return "json";
}

function parseFile(format: FileFormat, text: string): unknown {
  switch (format) {
    case "json":
      return JSON.parse(text);
    case "env":
      return DotEnv.parse(text);
    case "properties":
      return Properties.parse(text);
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

/**
 * A `Source` that reads a config tree from a local file — `.json`, `.env`, or `.properties` by
 * default (matched by `path`'s extension, or by the bare `.env` filename itself; anything else is
 * parsed as JSON), or any format via a custom `parser` option. `.properties` files follow the
 * `java.util.Properties` plain-text syntax and nest each dotted key into the tree
 * (`"game.initial-score=30"` => `{ game: { "initial-score": "30" } }`), same as Spring Boot's
 * `application.properties`. `path` may be a plain string or a `file:` `URL` (e.g.
 * `import.meta.resolve(...)` or `new URL("./config.json", import.meta.url)`). Like `fetchSource`
 * and `sseSource`, a read or parse failure is logged via `console.error` and leaves the store
 * empty (`null`) instead of throwing.
 *
 * `parser`, when set, overrides the default parsing entirely: it receives the file's raw bytes
 * and its return value is used as the parsed tree, which lets `fileSource` support formats like
 * YAML without a hard dependency on a YAML library:
 * `fileSource("./file.yaml", { parser: (bytes) => YAML.parse(new TextDecoder().decode(bytes)) })`.
 * `format` picks between the built-in parsers explicitly instead of relying on `path`'s
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
 * `sseSource` does for a bad SSE message. `watch: false` reads the file once and closes. Pass
 * `watch: { interval: <ms> }` to poll the file on a timer instead of using `fs.watch` — useful
 * where `fs.watch` doesn't fire reliably (e.g. some network mounts).
 *
 * `reduce` combines each read with the previously published value instead of replacing it
 * outright — handy with `watch` when a later read is a partial update rather than a full
 * snapshot.
 *
 * Every read (the initial one, and every `watch`-triggered re-read) bumps two built-in metrics,
 * exposed on the returned `Source` via `source.metrics`: `reads` (a `CounterMetric`) and
 * `readDuration` (a `HistogramMetric`, in seconds) — both labeled `ok` (`"true"` / `"false"`).
 */
export function fileSource<T = unknown>(
  path: string | URL,
  options: FileSourceOptions<T> = {},
): Source<T> {
  const watchOption = options.watch ?? true;
  const treePath = options.treePath ?? [];
  const parser = options.parser ?? defaultParser(path, options.format);
  const reduce = options.reduce;
  const metrics = createMetrics();
  let watcher: FSWatcher | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  return new Source<T>({
    metrics,
    async start(control) {
      async function readOnce(): Promise<boolean> {
        const startedAt = performance.now();
        const recordRead = (ok: boolean) => {
          const labels = { ok: String(ok) };
          metrics.reads.inc(labels);
          metrics.readDuration.observe(labels, (performance.now() - startedAt) / 1000);
        };

        const [readOk, readErr, buffer] = await t(() => readFile(path));
        if (!readOk) {
          console.error(`fileSource: failed to read "${path}"`, readErr);
          recordRead(false);
          return false;
        }

        const [parseOk, parseErr, parsed] = await t(() => parser(buffer));
        if (!parseOk) {
          console.error(`fileSource: failed to parse "${path}"`, parseErr);
          recordRead(false);
          return false;
        }

        const selected = selectTreePath(parsed, treePath);
        if (selected === undefined) {
          console.error(
            `fileSource: treePath [${treePath.map((k) => JSON.stringify(k)).join(", ")}] did not resolve to anything in "${path}"`,
          );
          control.set({} as T);
          recordRead(true);
          return true;
        }

        control.set(selected as T);
        recordRead(true);
        return true;
      }

      await readOnce();

      if (!watchOption) {
        control.close();
        return;
      }

      if (typeof watchOption === "object") {
        pollTimer = setInterval(() => {
          void readOnce();
        }, watchOption.interval);
        return;
      }

      watcher = watch(path, { persistent: false }, () => {
        void readOnce();
      });
    },
    close() {
      watcher?.close();
      clearInterval(pollTimer);
    },
    reduce,
  });
}
