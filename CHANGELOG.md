# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.11] - 2026-10-04

### Added

- `file()` fields now read from disk when a source's raw value is a `file://` URL (e.g. an env var
  `FOO=file:///etc/secrets/foo`), using that URL as `.location` instead of copying the content to a temp file.
  A value that can't be read is handled like any other decoding failure (`null`, or a `ConfigError` with `required`).
- The `Unsubscribe` function returned by `store.subscribe()`/`store.listen()` (and `Store.onMount`) is now
  `Disposable`, so it works with `using unsub = store.subscribe(...)`.

## [1.0.9] - 2026-09-29

### Added

- `fileSource` now supports a `"properties"` format (`.properties` files, detected automatically
  from that extension, or forced via `format: "properties"`) — the `java.util.Properties`
  plain-text syntax (`=`/`:`/whitespace separators, `#`/`!` comments, `\`-continued lines, and
  `\t`/`\n`/`\r`/`\f`/`\uXXXX`/`\`-escapes), with each dotted key nested into the config tree the
  same way Spring Boot's `application.properties` does — e.g. `game.initial-score=30` becomes
  `{ game: { "initial-score": "30" } }`.

## [1.0.8] - 2026-09-29

### Added

- `SourceControl.keys` — every field path (e.g. `[["server", "port"], ["HOST"]]`) a `Source` is
  being opened for, computed from the whole `create()`/`load()` shape and available inside
  `start(control)` before it does any work. Defaults to `[]` when a source is `open()`ed directly,
  without a `create()` shape behind it.

### Changed

- `envSource` now uses `control.keys` to decide which env vars to read: only a var whose mapped
  path is one of `control.keys` ends up in the tree. Opened through `create()`/`load()`, that's
  every field path the shape actually asks for. Opened directly (`source.open()`, with no keys
  passed and no `create()` shape behind it), `control.keys` is empty, so nothing is included —
  pass `open(keys)` explicitly to get anything back.
- **BREAKING**: `Source.start()` no longer runs eagerly at `new Source(...)` construction time —
  it's now deferred until the `Source` is first `open()`ed (directly, or by `create()`/`load()`
  opening it as one of `options.sources`), which is what makes `control.keys` available in time.
  A source constructed but never opened no longer runs its `start()` at all.

## [1.0.7] - 2026-09-28

### Changed

- **BREAKING**: the root entry point (`hotconfigs`) now re-exports only `envSource` as a source
  factory; `fileSource`, `literalSource`, and `pullSource` (previously re-exported from root
  alongside `envSource`) are no longer available from `hotconfigs`. They remain available,
  unchanged, from their own dedicated subpaths — `hotconfigs/sources/file`,
  `hotconfigs/sources/literal`, `hotconfigs/sources/pull` — along with their
  `FileSourceOptions`/`PullSourceOptions` types (also dropped from root). The `Source` base
  class itself keeps being re-exported from root, unchanged, since it carries no capability of
  its own. `fetchSource`/`sseSource`/`shellSource` were already subpath-only (see 1.0.5) and are
  unaffected.

## [1.0.5] - 2026-09-28

### Changed

- **BREAKING**: the root entry point (`hotconfigs`) no longer re-exports `fetchSource`,
  `sseSource`, `shellSource`, or their `FetchSourceOptions`/`FetchedEvent`/`SseSourceOptions`/
  `ShellSourceOptions`/`ShellRunEvent` types. Importing `hotconfigs` previously pulled in
  `fetch.ts`/`sse.ts` (network-capable code, using the global `fetch`/`EventSource`) and
  `shell.ts` (subprocess-execution code, via `node:child_process`) even for consumers who never
  construct one of those sources, which supply-chain scanners (e.g. Socket.dev) flag as "network
  access" and "shell access" capabilities on the whole package. `fetchSource`/`sseSource`/
  `shellSource` remain available, unchanged, from their dedicated subpaths —
  `hotconfigs/sources/fetch`, `hotconfigs/sources/sse`, and `hotconfigs/sources/shell` — so only
  consumers who actually import those subpaths pull in that capability. Every other source
  (`envSource`, `fileSource`, `literalSource`, `pullSource`) keeps re-exporting from the root as
  before.

## [1.0.4] - 2026-09-28

### Added

- **`file()`'s `mode`/`avoidCleanup`/`tempDir` options** — `mode` (default `0o400`) overrides the
  permission bits applied to a temp file `file()` writes out to disk; `avoidCleanup` (default
  `false`) can be set to `true` to leave the field's temp file/directory on disk instead of removing
  them on `close()`; `tempDir` overrides the base directory the temp file/directory is created under
  (defaulting to the OS temp directory) — mainly a debugging knob, for pointing it somewhere easy to
  find and inspect by hand. None of the three affect a `file:` `URL` default, since `file()` never
  created that file.

### Fixed

- A field whose path contains a sensitive word (`key`, `secret`, `password`, `token`,
  `credential`, `auth` — case-insensitive) now has its raw value masked (`***`) in the
  `ConfigError` thrown/reported when it fails to parse, instead of embedding the unparseable value
  verbatim in the error message.
- `file()`'s temp file/directory (used for any value that didn't already come from a real file on
  disk) are now created with minimal privileges — the directory `chmod`'d `0o700` and the file
  written `0o400` — so a secret handed to `file()` isn't left world/group-readable on disk.
- `file()`'s own `close()` now deletes every temp file/directory it created (its resolved default's,
  and one per raw value a live source published over the field's lifetime) instead of leaking them
  on disk indefinitely. A `file:` `URL` default — a real file `file()` didn't create — is left
  untouched.
- `shellSource`/`fetchSource` no longer leak full commands/URLs into their own `console.error` logs.
  `shellSource` masks a sensitive flag's value (`--key value` → `--key ****`, `--key=value` →
  `--key=****`) and a sensitive header-style argument's value, keeping any scheme prefix
  (`"Authorization: Bearer xxx"` → `"Authorization: Bearer ****"`, `"token: xxx"` → `"token:
  ****"`); `fetchSource` (and `httpFetch`'s own rejected-status error) masks a sensitive query
  parameter's value, and a Basic-auth password embedded in the URL's own userinfo
  (`https://user:pass@host/...` → `https://user:****@host/...`), in a logged URL. Neither affects
  `onRun`/`onFetched`, which are still handed the real, unmasked `args`/`url` — the caller already
  has whatever secret they put there.

## [1.0.2] - 2026-09-28

## [1.0.0]

### Added

- **`create(shape, options?)` / `load(shape, options?)`** — the public entry points for building a
  config tree from a typed shape. Given a shape of field descriptors (e.g. `{ port: numeric() }`),
  the returned object exposes each leaf key as a live `Store` — no `Proxy` — and is `then`able:
  `await`ing it resolves once every source (including every embedded `create()`'s own) has
  published its first snapshot. `load()` is identical to `create()` except its `options.sources`
  defaults to `[envSource()]`, so `load(shape)` alone reads straight from `process.env`; passing an
  explicit `sources` array overrides that default entirely rather than merging with it. A plain
  nested object in the shape (`{ server: { port: numeric() } }`) becomes a nested group of `Store`s
  sharing the parent's sources; a shape entry can also be **another, separate `create()` call**,
  adopted as-is — it resolves independently from its own `sources` and the parent's own `then()`
  also waits for it (`isConfigsNode` tells the two apart, and an embedded node's own errors surface
  in the parent's `ConfigValidationError`, with the embed's position in the shape tree prefixed onto
  each inherited path). Each leaf field is its own independent reactive chain (`Source → KeyStore →
  FieldStore`) instead of a global recompute sweep: every `options.sources` entry gets a placeholder
  `Store` wired into every field it could resolve from the moment `create()` is called, and once
  that source's `open()` resolves, its value (and every later update) ripples through only the
  fields whose path it can affect. The returned node (both its pending shape and what `then()`
  resolves to, `ConfigsNodeReady<T>`) exposes `close()` to release every source and field descriptor
  behind it, and implements `Symbol.asyncDispose` (`await using cfg = create(...)`) delegating to
  the same `close()`; `close()` memoizes its result, so calling it more than once never re-runs any
  descriptor's or source's own `close()` more than once.
- **`Descriptor`** — the base class every field type builds on, constructed with a single
  `start(control)` hook: `control.rawStore` is the field's live raw value merged across sources
  (read-only), `control.path` labels error messages, `control.set(value)` publishes the field's next
  value (sync at tick 0, or any number of times later via `control.rawStore.listen(...)`), and
  `control.error(error)` reports a field failure without tearing down the rest of the tree.
  `isConfigDescriptor()` recognizes any real `Descriptor` instance (`instanceof Descriptor`) — built
  directly or through a builder — across the published package's separately-compiled modules.
  `Descriptor`'s two type parameters (`Pending`/`Awaited`) are computed by each builder: `Pending` is
  what `.get()` returns before the node resolves (`T | null` without a `default`, `T` with one), and
  `Awaited` (via the exported `Settled<O, T>` type) is `T` once a `default` **or** `required: true`
  is set, `T | null` otherwise.
- **`string()`, `numeric()`, `boolean()`, `url()`, `choice(options)`, `shape(options)`, `list(options)`**
  — the built-in field-schema builders exported from `hotconfigs`, each returning a
  `Descriptor` instance:
  - `string()`/`numeric()`/`boolean()` parse a source's raw value into that primitive type.
  - `url()` parses a string into a `URL` instance, throwing a `ConfigError` on an invalid URL; its
    `base` option resolves a relative value against it (`new URL(raw, base)`), falling back to the
    environment's `location` (e.g. a browser's `window.location`) when available and `base` is
    omitted.
  - `choice({ options })` resolves to one of a fixed list of strings, rejecting any other value and
    narrowing its inferred type to the literal union of `options`.
  - `shape({ schema })` accepts any `Parseable<T>` (structurally `{ parse(value: unknown): T }` —
    what zod, valibot, and most validation libraries already export) for a fully library-validated
    field, with no added runtime dependency; omitting `schema` passes the raw value through as-is
    (typed `unknown`), only checking it's an object.
  - `list()` parses a comma-separated string into a `string[]`: a field wrapped in double quotes may
    contain literal commas (`"a,b",c` → `["a,b", "c"]`), and a backslash escapes a single character
    outside quotes (`a\,b,c` → `["a,b", "c"]`). An already-`string[]` raw value passes through as-is,
    and a raw `number`/`boolean` is wrapped into a single-element array. An empty (or
    whitespace-only) raw string splits to `[]` rather than `[""]`. Its `delimiter` option overrides
    the split character (`,` by default), or (`delimiter: false`) skips splitting altogether, so a
    value containing the delimiter resolves to a single-element array holding it verbatim.
    `avoidTrim` keeps each unquoted field's surrounding whitespace instead of trimming it.
  - Every builder accepts `default`, `required`, `summary`, and `key` (a `string | string[]` path
    overriding the field's own position in the shape tree, so a flat source can feed a nested
    shape). `required: true` is enforced at runtime for every built-in type: a required field still
    resolved to `null` once every source has settled is reported as a missing-value error at its own
    path.
- **`hotconfigs/node`'s `file()`/`FileBlob`** — a field-schema builder for reading a field's
  value as a file. A source's raw string value is decoded (as base64 or plain text, inferred
  automatically, or forced via `format: "text" | "base64"`) into a `FileBlob`, exposing `.text()`,
  `.json()`, `.formData()`, `.arrayBuffer()`, `.bytes()`, `.stream()`, `.exists()`, plus the
  synchronous `.size`, `.type` (MIME type inferred from `.location`'s filename), and `.location`
  (always set: a `file:` `URL` default is used as-is, any other value is written out to a fresh temp
  file whose `URL` becomes `.location`). `file({ default })` accepts a string or a `file:` `URL` read
  from local disk eagerly when `file()` is called; `file({ required: true })` narrows `.get()`'s
  type to `FileBlob` (never `null`).
- **`ConfigValidationError`** (extends `ConfigError`) and the exported **`ConfigFieldError`** type:
  `create()`/`load()` aggregate every field's own failure across the whole tree — by path — into
  one error instead of surfacing only the first one. `create()` itself never throws: every field
  error (a required value that could never be supplied, a parse failure escalated by `required:
  true`, or one reported via `control.error(...)`) only ever surfaces through the returned node's own
  reject (`await`/`.then()`), which lets an embedded `create()` node fail predictably before the
  parent even runs.
- **`Source`** — the base class every source builds on: `start(control)` pushes snapshots via
  `control.set(value)` (repeatable, for live sources) and calls `control.close()` when done; an
  optional `close()` releases what `start` set up. An optional `reduce(incoming, previous)` lets a
  source that only ever emits partial patches publish the merged result instead of keeping its own
  accumulator — every `control.set(incoming)` runs through it, with `previous` `null` before the
  first call.
- **`envSource`** — reads `process.env` (or any object) into the config tree, with pluggable key
  mapping via `mapKey`: `mapKey.snakeCase()`, `mapKey.identity()`, `mapKey.camelCase()`,
  `mapKey.lookup(table, fallback?)`, or a custom `(key: string) => string[]` mapper.
- **`fetchSource`** — pulls a JSON snapshot from a URL. Supports `attempts` retries, `bodyParser` to
  turn a non-JSON response into `T`, `acceptStatus` to customize which status codes count as
  success, `treePath` to select a subtree of the fetched body as the config tree, and `body`,
  `signal`, `mode`, `cache`, `redirect`, `credentials` (`{ basic: { username, password } }` or
  `{ bearer: { token } }`, setting the `Authorization` header) passed through to the underlying
  `fetch` call. `pollingInterval` keeps re-fetching `url` on an interval (each round retried up to
  `attempts` times) instead of fetching once and closing; `followCacheControl: true` lets each
  response's `Cache-Control` header decide the delay before the next poll (`max-age=<seconds>`
  schedules the next fetch that many seconds out, `no-store`/`no-cache` schedules it immediately),
  falling back to `pollingInterval` for any round whose response doesn't specify one.
  `useConditionalRequests` (on by default) sends a conditional GET every round after the first,
  echoing the previous response's `ETag`/`Last-Modified` back as `If-None-Match`/`If-Modified-Since`;
  a `304 Not Modified` reply is accepted and skipped, leaving the store at its last published value.
- **`sseSource`** — live updates over Server-Sent Events; each message is parsed and applied as a
  shallow patch-merge on top of what was already received by default, so the tree accumulates
  instead of being replaced wholesale. `overwrite: true` replaces the accumulated tree wholesale with
  each parsed message instead. Accepts the same request-shaping options as `fetchSource`: `body`,
  `signal`, `mode`, `cache`, `redirect`, `credentials`, `attempts` (retries only the initial
  connection), and `acceptStatus`.
- **`fileSource`** — reads a config tree from a local file, watching it for changes by default
  (`watch: true`) and re-publishing on every update; `watch: { interval: <ms> }` polls the file on a
  timer and re-reads it unconditionally instead of using `fs.watch`, for filesystems where `fs.watch`
  doesn't fire reliably (e.g. some network mounts). Decodes the file as UTF-8 and parses it as `.env`
  (for a `.env`-named path) or JSON otherwise, or picks the built-in parser explicitly via
  `format: "json" | "env"` (useful for an extensionless path); a `parser?: (buffer: Uint8Array) =>
  unknown` option reads formats it doesn't parse itself (e.g. YAML). Accepts `treePath` to select a
  subtree of the parsed file as the config tree.
- **`literalSource`** — publishes a static, already-in-hand value once and closes; useful as a
  fallback tree at the end of a `sources` array.
- **`pullSource`** — calls a `pull` function on a fixed `interval` (in milliseconds), publishing
  whatever it returns as the next config tree snapshot. `pull` runs once immediately on start, then
  again every `interval` until the source closes; a failed round is logged and swallowed, keeping
  the last good value (or closing with an empty store if the very first call fails).
- **`shellSource(args, options?)`** — runs `args` as a child process and publishes its parsed stdout
  as the config tree, e.g. `shellSource(["gh", "auth", "token", "--format", "json"])`. Supports
  `stdoutParser` (defaults to `JSON.parse`), `acceptExitCode`, `attempts` retries, `treePath`,
  `pollingInterval`, `reduce`, and an `onRun` callback, mirroring `fetchSource`'s shape.
- **`fetchSource`**, **`sseSource`**, and **`fileSource`** all accept a `reduce?: (incoming: T,
  previous: T | null) => T` option, so a later snapshot can be combined with the previously
  published value instead of always replacing it outright.
- **`hotconfigs/react`'s `useConfig(store)`** — a hook built on `useSyncExternalStore` that
  subscribes a component to any config field or nested group's `Store`/`ReadOnlyStore` and
  re-renders it on updates. React is an optional peer dependency, externalized from the build.
- **`ConfigError`** for schema/config-level errors, and `DataTypes`/`DataTypeName` for the field type
  and coercion helpers backing schema fields.
- **`DotEnv`** — a `.env`-file parser (exported from `hotconfigs`) matching the quoting,
  escaping, and multi-line value rules of the common `.env` format, used internally by `fileSource`
  and available standalone.
- **`hotconfigs/utils/metrics`** — Prometheus-style metric helpers (counters, gauges,
  histograms, and summaries with configurable quantiles and a sliding time window), for
  instrumenting a config tree's own sources and fields.

[1.0.11]: https://github.com/JonDotsoy/configs/releases/tag/v1.0.11
[1.0.9]: https://github.com/JonDotsoy/configs/releases/tag/v1.0.9
[1.0.8]: https://github.com/JonDotsoy/configs/releases/tag/v1.0.8
[1.0.7]: https://github.com/JonDotsoy/configs/releases/tag/v1.0.7
[1.0.5]: https://github.com/JonDotsoy/configs/releases/tag/v1.0.5
[1.0.4]: https://github.com/JonDotsoy/configs/releases/tag/v1.0.4
[1.0.2]: https://github.com/JonDotsoy/configs/releases/tag/v1.0.2
[1.0.0]: https://github.com/JonDotsoy/configs/releases/tag/v1.0.0
