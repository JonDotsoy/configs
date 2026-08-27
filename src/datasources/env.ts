import { DataSource } from "./datasource";

/** Maps an env var key to a path into the config tree, e.g. `mapKey("FOO_TAR")`. */
export type EnvKeyMapper = (key: string) => string[];

export interface EnvDataSourceOptions {
  /** The env vars to read. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Only keys starting with `prefix` are included; the prefix is stripped before `mapKey` runs. */
  prefix?: string;
  /** Only keys ending with `suffix` are included; the suffix is stripped before `mapKey` runs. */
  suffix?: string;
  /** Maps each key to a path. Defaults to the identity mapping: `"FOO_TAR" => ["FOO_TAR"]`. */
  mapKey?: EnvKeyMapper;
}

/** Splits a `SCREAMING_SNAKE_CASE` env key into a lowercase nested path: `"FOO_TAR" => ["foo", "tar"]`. */
export function envKeyToPath(key: string): string[] {
  return key.toLowerCase().split("_");
}

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

/** A `DataSource` that snapshots `env` into a config tree, one field per key (as mapped by `mapKey`). */
export function envDataSource(options: EnvDataSourceOptions = {}): DataSource<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const { prefix, suffix } = options;
  const mapKey = options.mapKey ?? ((key: string) => [key]);

  return new DataSource<Record<string, unknown>>({
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
