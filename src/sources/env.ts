import { Source } from "./source.js";

/** Maps an env var key to a path into the config tree, e.g. `mapKey("FOO_TAR")`. */
export type EnvKeyMapper = (key: string) => string[];

export interface EnvSourceOptions {
  /** The env vars to read. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Only keys starting with `prefix` are included; the prefix is stripped before `mapKey` runs. */
  prefix?: string;
  /** Only keys ending with `suffix` are included; the suffix is stripped before `mapKey` runs. */
  suffix?: string;
  /** Maps each key to a path. Defaults to the identity mapping: `"FOO_TAR" => ["FOO_TAR"]`. */
  mapKey?: EnvKeyMapper;
}

/** Built-in `mapKey` strategies for `EnvSourceOptions.mapKey`, each a factory returning an `EnvKeyMapper`. */
export const mapKey = {
  /**
   * Splits an env key into a lowercase nested path on `separator` (default `"_"`):
   * `"FOO_TAR" => ["foo", "tar"]`. Pass a different `separator` (e.g. `"__"`) to keep a single
   * underscore inside a segment from splitting it, e.g. `"API_KEY_V2"` with `separator: "__"`.
   */
  snakeCase(options: { separator?: string } = {}): EnvKeyMapper {
    const separator = options.separator ?? "_";
    return (key: string) => key.toLowerCase().split(separator);
  },

  /** Passes each key through unchanged, as a single-segment path: `"FOO_TAR" => ["FOO_TAR"]`. Equivalent to the default when `mapKey` is omitted — spells it out explicitly. */
  identity(): EnvKeyMapper {
    return (key: string) => [key];
  },

  /** Maps an env key to a single camelCase segment: `"FOO_TAR" => ["fooTar"]`. */
  camelCase(): EnvKeyMapper {
    return (key: string) => [key.toLowerCase().replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase())];
  },

  /**
   * Maps specific env keys to explicit paths via a `table` lookup, e.g.
   * `mapKey.lookup({ PORT: ["server", "port"] })` maps `"PORT" => ["server", "port"]`. A key not
   * found in `table` falls back to `fallback` (default: the identity mapping, `key => [key]`).
   */
  lookup(table: Record<string, string[]>, fallback: EnvKeyMapper = (key: string) => [key]): EnvKeyMapper {
    return (key: string) => table[key] ?? fallback(key);
  },
};

function setPath(target: Record<string, unknown>, path: string[], value: string): void {
  let node = target;
  for (const segment of path.slice(0, -1)) {
    const next = node[segment];
    if (typeof next !== "object" || next === null) {
      node[segment] = {};
    }
    node = node[segment] as Record<string, unknown>;
  }
  node[path[path.length - 1]!] = value;
}

/** A `Source` that snapshots `env` into a config tree, one field per key (as mapped by `mapKey`). */
export function envSource(options: EnvSourceOptions = {}): Source<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const { prefix, suffix } = options;
  const mapKey = options.mapKey ?? ((key: string) => [key]);

  return new Source<Record<string, unknown>>({
    start(control) {
      const tree: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) continue;
        if (prefix !== undefined && !key.startsWith(prefix)) continue;
        if (suffix !== undefined && !key.endsWith(suffix)) continue;

        const trimmedKey = key.slice(
          prefix !== undefined ? prefix.length : 0,
          suffix !== undefined ? key.length - suffix.length : key.length,
        );
        setPath(tree, mapKey(trimmedKey), value);
      }
      control.set(tree);
      control.close();
    },
  });
}
