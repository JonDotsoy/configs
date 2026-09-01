# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`fileSource`** now accepts a `parser?: (buffer: Uint8Array) => unknown` option, letting it
  read formats it doesn't parse itself — e.g. YAML with a library of your choice:
  `fileSource("./file.yaml", { parser: (bytes) => YAML.parse(new TextDecoder().decode(bytes)) })`.
  When omitted, `fileSource` decodes the file as UTF-8 and parses it as `.env` (for a
  `.env`-named path) or JSON otherwise — a file with an unrecognized extension is no longer
  rejected up front; it's parsed as JSON like anything else, and fails the same way invalid JSON
  always does.

## [1.1.1] - 2026-09-01

### Added

- **`@jondotsoy/configs/react`** — a `useConfig(store)` hook built on
  `useSyncExternalStore` that subscribes a component to any config field or
  nested group and re-renders it on updates. React is an optional peer
  dependency, externalized from the build so importing this subpath is the
  only way it's pulled in.

### Fixed

- `configs.create()`'s field `Store`s are now readable synchronously, even
  before the returned node's sources have finished opening: a field read
  (and cached) while still pending now catches up once its source resolves,
  instead of staying stuck at its initial `null`/default value forever.
- `configs.create()` now returns a plain object (a `Proxy` over an object
  literal) instead of a class instance — no more `ConfigNode`/
  `ConfigNodeResolved` classes or `instanceof` checks. Only `default` now
  narrows a field's type to non-null, consistently whether the node is
  resolved or not — `required` documents intent only and is never enforced
  at runtime.

## [1.1.0] - 2026-08-30

### Added

- **`pullSource`** — a `Source` that calls a `pull` function on a fixed `interval` (in
  milliseconds), publishing whatever it returns as the next config tree snapshot. `pull` runs
  once immediately on start, then again every `interval` until the source closes; a failed round
  is logged via `console.error` and swallowed, keeping the last good value (or closing with an
  empty store if the very first call fails).
- **`fetchSource`** now supports `pollingInterval` to keep re-fetching `url` on an interval
  (each round retried up to `attempts` times) instead of fetching once and closing, plus
  `bodyParser` to turn a non-JSON response into `T` and `acceptStatus` to customize which status
  codes count as a successful fetch.
- **`FetchSourceOptions`**/the internal `httpFetch` helper now support `body`, `signal`, `mode`,
  `cache`, and `redirect`, passed through to the underlying `fetch` call, plus `credentials` for
  setting the `Authorization` header (`{ basic: { username, password } }` or
  `{ bearer: { token } }`).

## [1.0.1]

### Fixed

- Internal relative imports/exports in `src/*.ts` now carry an explicit `.js` extension,
  so `tsc`'s declaration emit preserves it into `dist/**/*.d.ts` — the published types now
  resolve correctly under `moduleResolution: node16`/`nodenext`, the setting TypeScript
  recommends for consuming a published ESM package from Node. Previously, a bare relative
  specifier in the source came out just as bare in the `.d.ts`, which that resolution mode
  can't resolve, breaking type-checking for Node and Deno consumers.
- `FetchSourceOptions`/`SseSourceOptions.headers` is now typed as `RequestInit["headers"]`
  instead of `Bun.HeadersInit`. The Bun-specific type was leaking into published
  declarations, breaking type-checking for any Node/Deno consumer without `bun-types`
  installed, even when `headers` was never used.

## [1.0.0]

### Added

- **`configs.create()`** — the public entry point for building a config tree from a typed
  schema. Every field resolves to a live `Store`, so `cfg.field.get()` reads the current value
  and `cfg.field.subscribe(...)` reacts to it changing at runtime. Schemas are statically
  checked: `cfg.port.get()` infers as `number | null`, narrowing to `number` once a `default`
  is set. Nested groups compose by passing a `configs.create(...)` call as a shape property.
  The result (and every nested group) exposes `close()` to release every source behind it, and
  implements `Symbol.asyncDispose` for `await using`.
- **`Source`** — the base class every source builds on: `start(control)` pushes snapshots via
  `control.set(value)` (repeatable, for live sources) and calls `control.close()` when done; an
  optional `close()` releases what `start` set up. An optional `reduce(incoming, previous)` lets
  a source that only ever emits partial patches publish the merged result instead of keeping its
  own accumulator.
- **`envSource`** — reads `process.env` (or any object) into the config tree, with pluggable key
  mapping via `mapKey`: `mapKey.snakeCase()`, `mapKey.identity()`, `mapKey.camelCase()`,
  `mapKey.lookup(table, fallback?)`, or a custom `(key: string) => string[]` mapper.
- **`fetchSource`** — pulls a JSON snapshot from a URL, with retry via `attempts` and graceful
  fallback (logs and leaves the store empty) on a failed download or invalid JSON.
- **`sseSource`** — live updates over Server-Sent Events; each message is parsed and applied as a
  patch on top of what was already received, so the tree accumulates instead of being replaced
  wholesale.
- **`fileSource`** — reads a config tree from a local `.json` or `.env` file, watching it for
  changes by default (`watch: true`) and re-publishing on every update.
- **`literalSource`** — publishes a static, already-in-hand value once and closes; useful as a
  fallback tree at the end of a `sources` array.
- `ConfigError` for schema/config-level errors, and `DataTypes`/`DataTypeName` for the field type
  and coercion helpers backing schema fields.

[1.1.1]: https://github.com/JonDotsoy/configs/releases/tag/v1.1.1
[1.1.0]: https://github.com/JonDotsoy/configs/releases/tag/v1.1.0
[1.0.1]: https://github.com/JonDotsoy/configs/releases/tag/v1.0.1
[1.0.0]: https://github.com/JonDotsoy/configs/releases/tag/v1.0.0
