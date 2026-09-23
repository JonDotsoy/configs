# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`string()`, `numeric()`, `boolean()`** — field-schema builder functions exported from
  `@jondotsoy/configs`, shorthand for `{ type: "string" | "number" | "boolean", ... }` object
  literals (e.g. `numeric({ summary: "HTTP port", default: 3000 })` instead of
  `{ type: "number", summary: "HTTP port", default: 3000 }`). Each accepts the same options as its
  `FieldSchema` variant, minus `type`, and now also a `key?: string | string[]` option (see below).
  They return a new exported `ConfigDescriptor<T>` instance instead of a plain object literal.
- **`key` field option** — every field (via `string()`/`numeric()`/`boolean()`, or the
  `key` property on an explicit `FieldSchema` object literal) can now set `key: "PORT"` (or a
  `string[]` path) to read from that exact path in each source's snapshot, instead of the field's
  own position in the shape tree. Lets a flat `envSource()` feed a nested shape directly, e.g.
  `server: { port: numeric({ default: 3000, key: "PORT" }) }` reads the source's top-level `PORT`.
- **Plain nested shapes** — a shape property can now be a plain object (`server: { port: ..., host:
  ... }`) instead of requiring `create({...})`, and is treated as an implicit nested group that
  shares its parent's sources, same as `server: create({...})` with no `options`.
- **`shellSource(args, options?)`** — a new `Source` that runs `args` as a child process (via
  `node:child_process`'s `spawn`) and publishes its parsed stdout as the config tree, e.g.
  `shellSource(["gh", "auth", "token", "--format", "json"])`. Supports `stdoutParser` (defaults to
  `JSON.parse`), `acceptExitCode`, `attempts` retries, `treePath`, `pollingInterval`, `reduce`, and
  an `onRun` callback, mirroring `fetchSource`'s shape. Exported from `@jondotsoy/configs` and as
  the `@jondotsoy/configs/sources/shell` subpath.
- **`fetchSource`** now accepts a `followCacheControl?: boolean` option: when `true`, each
  response's `Cache-Control` header decides the delay before the next poll (`max-age=<seconds>`
  schedules the next fetch that many seconds out, `no-store`/`no-cache` schedules it immediately),
  falling back to `pollingInterval` for any round whose response doesn't specify one. Can be set
  alone (`pollingInterval` left `false`) to poll purely off what the server reports.
- **`fetchSource`** now accepts a `useConditionalRequests?: boolean` option, **on by default**:
  every round after the first sends a conditional GET, echoing the previous response's
  `ETag`/`Last-Modified` back as `If-None-Match`/`If-Modified-Since`. A `304 Not Modified` reply is
  accepted and skipped, leaving the store at its last published value instead of being overwritten.
  Set it to `false` to always send a plain, unconditional GET.
- **`fileSource`**'s `watch` option now also accepts `{ interval: <ms> }`, which polls the file on
  a timer and re-reads it unconditionally instead of using `fs.watch`. Useful where `fs.watch`
  doesn't fire reliably (e.g. some network mounts).

## [1.2.1] - 2026-09-04

### Changed

- `publish.yaml`: publish now triggers off a `package.json` version change on `develop` instead of
  a `v*` tag push, checks whether a GitHub release for that version already exists before doing
  any work, and only creates the GitHub release (with notes from this file) after `npm publish`
  succeeds.

## [1.2.0] - 2026-09-03

### Added

- **`type: "shape"`** field — takes an optional `schema` that's any `Parseable<T>` (structurally
  `{ parse(value: unknown): T }`, exactly what zod, valibot, and most validation libraries already
  export), so complex, library-validated fields are supported without adding a runtime dependency.
  `{ type: "shape" }` alone passes the raw value through as-is (typed `unknown`), only checking
  it's an object. `type` can be omitted when `schema` is set (`{ port: { schema: z.number() } }`),
  and a schema can be used directly as a shape entry, skipping the wrapper entirely
  (`create({ port: z.number() })`) — though that shorthand has no room for
  `summary`/`required`/`readonly`/`default`. A failed parse (or, with no schema, a non-object
  value) is logged via `console.error` and the field resolves to `null` instead of failing the
  whole config tree, unless `required: true` escalates it into a thrown `ConfigError`.
- **`sseSource`** now accepts an `overwrite?: boolean` option (default `false`). Set it to `true`
  to replace the accumulated tree wholesale with each parsed message instead of the default
  shallow patch-merge. A custom `reduce`, if set, still takes precedence over `overwrite`.

## [1.1.4] - 2026-09-01

### Added

- **`create`** — a named export equivalent to `configs.create`, so `configs.create(...)` can also
  be written as `import { create } from "@jondotsoy/configs"; create(...)`.
- **`sseSource`** now accepts the same request-shaping options as `fetchSource`: `body`, `signal`,
  `mode`, `cache`, `redirect`, `credentials`, `attempts` (retries only the initial connection), and
  `acceptStatus`.
- **`fetchSource`** now accepts a `treePath?: string[]` option, same as `fileSource`'s, to select a
  subtree of the fetched body as the config tree instead of the whole response — applied on every
  round, including polled ones.
- **`fetchSource`**, **`sseSource`**, and **`fileSource`** now accept a
  `reduce?: (incoming: T, previous: T | null) => T` option, so a later snapshot can be combined
  with the previously published value instead of always replacing it outright — most useful for
  `fetchSource` with `pollingInterval` and `fileSource` with `watch`, when a later round/read is a
  partial update rather than a full snapshot. `fetchSource` and `fileSource` default to a full
  replace (`reduce` unset); `sseSource` defaults to its existing shallow patch-merge, which a
  custom `reduce` now overrides entirely instead of being fixed behavior.

## [1.1.2] - 2026-09-01

### Added

- **`fileSource`** now accepts a `parser?: (buffer: Uint8Array) => unknown` option, letting it
  read formats it doesn't parse itself — e.g. YAML with a library of your choice:
  `fileSource("./file.yaml", { parser: (bytes) => YAML.parse(new TextDecoder().decode(bytes)) })`.
  When omitted, `fileSource` decodes the file as UTF-8 and parses it as `.env` (for a
  `.env`-named path) or JSON otherwise — a file with an unrecognized extension is no longer
  rejected up front; it's parsed as JSON like anything else, and fails the same way invalid JSON
  always does.
- **`fileSource`** also accepts a `format?: "json" | "env"` option to pick the built-in parser
  explicitly instead of relying on `path`'s extension — e.g. for an extensionless path:
  `fileSource("./config", { format: "env" })`. Ignored once `parser` is set.

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

[1.2.1]: https://github.com/JonDotsoy/configs/releases/tag/v1.2.1
[1.2.0]: https://github.com/JonDotsoy/configs/releases/tag/v1.2.0
[1.1.4]: https://github.com/JonDotsoy/configs/releases/tag/v1.1.4
[1.1.2]: https://github.com/JonDotsoy/configs/releases/tag/v1.1.2
[1.1.1]: https://github.com/JonDotsoy/configs/releases/tag/v1.1.1
[1.1.0]: https://github.com/JonDotsoy/configs/releases/tag/v1.1.0
[1.0.1]: https://github.com/JonDotsoy/configs/releases/tag/v1.0.1
[1.0.0]: https://github.com/JonDotsoy/configs/releases/tag/v1.0.0
