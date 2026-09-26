# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The root `package.json` is now `"private": true` and no longer carries an
  `exports` map or `publishConfig`/`files` (it's never published itself,
  only `dist/package.json` is — see the `npm publish ./dist` change below).
  Its former `exports` map (each condition's `_entryPoint` plus `types`/
  `import` pointing into `dist/`) is replaced by a plain `_buildEntripoint`
  map of subpath -> `src/*.ts` source; `scripts/build.ts` derives
  `dist/package.json`'s own `exports` from it. `tsconfig.json` gained a
  matching `paths` map (kept in sync with `_buildEntripoint`) so
  `test/cases/*.ts`'s `@jondotsoy/configs` imports still type-check against
  `dist/`'s `.d.ts` output, now that there's no `exports` map left for
  TypeScript's package self-reference to resolve them against.
- The `Publish Package` workflow (`.github/workflows/publish.yaml`) now
  checks out, commits the version bump to, and targets the GitHub release at
  the branch the workflow run was actually triggered on or dispatched
  against (`github.ref_name`), instead of always hardcoding the repository's
  default branch — running it manually against a non-default branch no
  longer silently commits and releases on the default branch instead.
- The `Publish Package` workflow (`.github/workflows/publish.yaml`) now runs
  `npm publish ./dist` instead of `npm publish` at the repo root, publishing
  `dist/`'s own self-contained `dist/package.json` directly as the package
  manifest.
- `bun run test:cases` (`scripts/run-test-cases.ts`) now packs the tarball it
  installs and tests against with `npm pack` run *inside* `dist/` (its own
  `dist/package.json` as the manifest), instead of `bun pm pack` at the repo
  root — the same publish-from-`dist/` artifact `npm publish` would produce,
  so the integration cases exercise exactly what gets published.
- Replaced `scripts/build.sh` with `scripts/build.ts`: the build now runs as a
  typed Bun script instead of Bash, minifies the bundled output
  (`bun build --minify`), and writes a trimmed, self-contained
  `dist/package.json` (dev-only fields dropped, `exports` paths relative to
  `dist/` itself) alongside the compiled `.js`/`.d.ts` files.

## [1.2.12] - 2026-09-26

### Changed — every built-in `Descriptor`'s own `start` is now a single `control.rawStore.subscribe(...)` call

Previously each built-in field builder (`string()`/`numeric()`/`boolean()`/`url()`/`shape()`/
`choice()`, and `file()` from `./node.js`) wrote its own `start` as two steps: an initial
`control.set(...)` seeded from `control.rawStore.get()`, then a `control.rawStore.listen((raw) =>
control.set(...))` to stay live — the same parse-or-default expression duplicated at both call
sites. `ReadOnlyStore.subscribe()` already fires immediately with the current value and again on
every later change, so a single `control.rawStore.subscribe((raw) => control.set(...))` call does
both jobs at once. No behavior change — `subscribe`'s immediate call happens synchronously inside
`start`, same tick-0 timing as the old `get()` + `set()` pair. A hand-written `Descriptor` gets the
same simplification for free — see the README's "Writing a custom `Descriptor`" section.

### Changed — `Descriptor<T, O>` is now `Descriptor<A, B>`

`Descriptor`'s type parameters now directly encode a field's two type-level states instead of
carrying the plain value type plus its raw `options`: `A` is what `.get()` actually returns right
now (`T | null` without a `default`, `T` with one), `B` is the field's *resolved* type once it has
a value (always `T`, regardless of `default`). `numeric()` returns `Descriptor<number | null,
number>` on its own, or `Descriptor<number, number>` with a `default` — previously this was always
`Descriptor<number, O>`, with the `T | null` vs. `T` distinction computed separately, downstream,
by `create()`'s own type inference (`O extends { default: any } ? T : T | null`). That computation
now lives on `Descriptor` itself, via a new exported `WithDefault<O, T>` type (`T` when `O` has a
`default`, `T | null` otherwise) that every built-in builder plugs into its own `A`. `create()`'s
inference simplifies to reading `A` straight off the field's own `Descriptor`. `Descriptor`'s
constructor and `.start(control)` shape are unaffected — this is a type-only change; the second
type argument, when given explicitly (e.g. a hand-written `Descriptor<T, O>` from before this
change), now means something different (`B` instead of `O`), so update any such usage to
`Descriptor<T>` (`B` defaults to `A`) unless it specifically needs `B`. See the README's
"TypeScript inference" and "Writing a custom `Descriptor`" sections.

### Removed — the `Parser<T>` type

No longer exported from the package root or `config-descriptor.ts`. `DescriptorUnderlying.start`
(and every built-in `*Parser()` helper's return type) is now written inline as
`(raw: unknown, path: string[]) => T` instead of naming a dedicated type — nothing outside this
package ever needed to reference `Parser<T>` by name, since `start` is always written as a plain
function literal.

### Removed — `CONFIG_DESCRIPTOR_TAG`

Removed entirely (`src/utils/config-descriptor-tag.ts` is gone), along with the `[symbol]: true`
hand-written contract it enabled. `isConfigDescriptor()` recognizes a `Descriptor` structurally now
— any object with a callable `.start()` (no tag, no `instanceof` check needed) — so every real
`Descriptor` still gets recognized across separately-bundled entry points, and a hand-written
descriptor no longer needs to import anything to be one. An object without a `.start()` at all is
not recognized as a descriptor — `create()` treats it as a nested group instead. See the README's
"Writing a custom `Descriptor`" section.

### Changed — BREAKING: `ConfigDescriptor` renamed to `Descriptor`, rebuilt around a single `start(control)` hook modeled directly after `Source`

`ConfigDescriptor` is now exported as `Descriptor`, and its constructor takes a single options
object with one hook — `start(control)` — instead of the old positional `(type, parser, options)`,
and instead of the intermediate `start`/`reduce` two-hook shape this same `[Unreleased]` section
described in an earlier draft (never published):

```ts
new Descriptor<T>({
  type: "csv",
  options: { key: "ALLOWED_ORIGINS" },
  start(control) {
    // control.rawStore: this field's live raw value, merged across sources (read-only)
    // control.path: for labeling an error message
    // control.set(value): publish the field's next value — sync (tick 0) or any time later
    control.set(parse(control.rawStore.get(), control.path));
    control.rawStore.listen((raw) => control.set(parse(raw, control.path)));
  },
  close(): Promise<void> { /* optional: release whatever start() set up */ },
})
```

Same shape as `Source`'s own `UnderlyingSource.start(control)`, and the same rule: `create()` calls
`start(control)` exactly once, synchronously, when the field is built, and never awaits it — a
field's value is 100% controlled by whatever `start` does with `control.set()`, whether that's once
synchronously (before `create()` even returns) or any number of times later (a
`control.rawStore.listen()` callback, a `setTimeout`, a resolved `fetch()`, ...). There's no
implicit reactivity: a `start` that calls `control.set()` once and never listens to
`control.rawStore` leaves the field at that value forever, even the source's very first update
never reaches it. There's no shared helper for this — every built-in field type
(`string()`/`numeric()`/`boolean()`/`url()`/`choice()`/`shape()`, and `file()` from `./node.js`)
writes its own `start`, seeding `control.set()` once synchronously against its own parser (falling
back to `options.default` when raw is missing) and again on every `control.rawStore.listen()`
update — a hand-written `Descriptor` can write the same shape to get the same "live from the moment
the source opens" behavior. See the README's "Writing a custom `Descriptor`" section.

### Changed — BREAKING: new `create()`/`load()` engine, legacy engine removed

`src/config-node.ts`'s `create()` is now what `create`/`load` (from the package root) build on —
replacing the old `src/config.types.ts` engine entirely, which has been deleted along with
everything that only made sense for it. This is a breaking change: read through if you use
`configs.create()`, object-literal fields (`{ type: "string", ... }`), a bare schema/`{ schema }`
shape shorthand, `freeze`, or the root's `.get()`/`.subscribe()`/`.close()`.

- **`create(shape, options?)` / `load(shape, options?)`** are exported from the package root as
  before, now backed by the new engine. Given a shape of `ConfigDescriptor`s (e.g. `{ port:
  numeric() }`), the returned object exposes each leaf key as a live `Store` directly — no `Proxy`.
  A plain nested object in the shape (`{ server: { port: numeric() } }`) becomes a nested group of
  `Store`s of its own, resolved from each source's own matching nested path; a shape entry can
  also be **another, separate `create()` call** (`{ server: { tls: create({ cert: string() }, {
  sources: [...] }) } }`), adopted as-is — it resolves independently from its own `sources`, never
  looked up against the parent's, and the parent's own `then()` also waits for it (`isConfigsNode`,
  also exported, tells the two apart). `key` (`numeric({ key: "PORT" })`) still works the same as
  before: an explicit, absolute path override. The returned object is `then`able: `await`ing it
  resolves once every source (including every embedded `create()`'s own) has published its first
  snapshot, into the same plain shape (no longer `then`able).

  Internally, each leaf field is its own independent reactive chain — `Source → KeyStore →
  FieldStore` — instead of one global recompute sweep over the whole shape on every change: each
  `options.sources` entry gets a placeholder `Store`, wired into every field it could resolve from
  the moment `create()` is called; once that source's own `open()` resolves, its value (and every
  later update) forwards into the placeholder and ripples through only the fields whose path it
  can affect.
- **`Descriptor.start(control)`**: what every field's live `Store` is now built from — see the
  "`ConfigDescriptor` renamed to `Descriptor`" entry above for the current shape of this contract
  (it changed more than once within this same `[Unreleased]` section before settling).

### Removed

- **The legacy `configs.create()` engine (`src/config.types.ts`) is gone**, along with the
  `configs` namespace object that exposed it. Use `create()`/`load()` from the package root
  instead — same names, new engine (see above).
- **Object-literal fields (`{ type: "string", ... }` and friends) are no longer accepted** — only
  `string()`/`numeric()`/`boolean()`/`url()`/`choice()`/`shape()` (or a hand-built
  `ConfigDescriptor`). Likewise, a bare schema used directly as a shape entry (`port: z.number()`)
  and the untagged `{ schema: z.number() }` shorthand are no longer accepted — wrap them in
  `shape({ schema: ... })`.
- **The root node's `.get()`, `.subscribe()`, `.listen()`, `.close()`, and `[Symbol.asyncDispose]`
  are gone** — the new engine's node only ever exposes the shape's own fields, nothing else. To
  read a snapshot of the whole tree, walk it yourself; to close a `Source`, call `.close()` on the
  `Source` instance itself (`create()` never retains it for that).
- **`ConfigDescriptor.parse()` is gone** — it was a `Promise`-wrapping shim kept only for the now-
  deleted legacy engine. See the "`ConfigDescriptor` renamed to `Descriptor`" entry above for
  today's replacement (`start(control)`).
- `freeze` is still a recognized field option (kept for now, to limit the size of this change) but
  has no effect: no remaining engine acts on it.

## [1.2.6] - 2026-09-25

### Changed

- **Renamed the field option `readonly` to `freeze`** (e.g. `{ port: { type: "number", freeze: true } }`,
  `numeric({ freeze: true })`, `file({ freeze: true })`). The option's behavior is unchanged — it
  still freezes the field at its first resolved value, ignoring later source updates — only the
  name changed, to stop reading like it's related to `ReadOnlyStore<T>` (the read-only accessor
  every field has, frozen or not). This is a breaking rename: a shape still using `readonly: true`
  will no longer freeze that field.

### Deprecated

- **Defining a field as an object literal — `{ type: "string" | "number" | "boolean" | "url" |
  "shape", ... }` — is deprecated** in favor of `string()`/`numeric()`/`boolean()`/`url()`/
  `shape()`. It's still fully supported (nothing breaks, nothing is removed) but now logs a
  one-time `console.warn` the first time a field is resolved from that form, and its
  `StringFieldSchema`/`NumberFieldSchema`/`BooleanFieldSchema`/`UrlFieldSchema` types (and the
  internal `"shape"` variant) now carry `@deprecated` JSDoc tags. The type-less shorthands (a bare
  schema used directly, e.g. `port: z.number()`, and `{ schema: z.number() }` with no `type`) are
  **not** affected — only the tagged form is.

### Added

- **Writing a custom field type — `ConfigDescriptor`'s constructor, `.parse()`, `.key`, and `.freeze`
  are now public.** `new ConfigDescriptor(type, parser, options)` builds a field descriptor from your own
  `parser: Parser<T>` (`(raw: unknown, path: string[]) => T`, throw a `ConfigError` to reject a
  value) — `string()`/`numeric()`/`boolean()`/`url()`/`shape()`, and `@jondotsoy/configs/node`'s
  `file()`, each now build their own dedicated parser this way. `configs.create()`/`load()` treat
  any `ConfigDescriptor`-backed shape entry identically regardless of who built it: it resolves the
  field's path (its own nesting in the shape tree, or an explicit `key`), merges a live raw value
  across sources into a `Store`, and hands that to the descriptor's own `parse(rawStore, path?):
  Promise<{ store }>` — the descriptor never needs to know about sources or its siblings. The
  `CONFIG_DESCRIPTOR_TAG` symbol and the `Parser<T>` type are also newly exported, for the rarer
  case of writing a descriptor entirely by hand instead of constructing the class. See the
  README's new "Writing a custom `ConfigDescriptor`" section.
- **`@jondotsoy/configs/node`'s `file()`/`FileBlob`** — a new field-schema builder for reading a
  field's value as a file. A source's raw string value is decoded (as base64 or plain text,
  inferred automatically, or forced via `file({ format: "text" | "base64" })`) into a `FileBlob`,
  exposing `.text()`, `.json()`, `.formData()` (parses `application/x-www-form-urlencoded` text
  like `foo=tar&biz=lol`), `.arrayBuffer()`, `.bytes()`, `.stream()`, `.exists()`, plus the
  synchronous `.size`, `.type` (MIME type inferred from `.location`'s filename), and `.location` —
  always set: a `file:` `URL` default is used as-is, and any other value (a source's raw value, or
  a string `default`) is written out to a fresh temp file whose `URL` becomes `.location`.
  `file({ default })` accepts a string (same decoding as a source value) or a `file:` `URL` read
  from local disk eagerly when `file()` is called — a missing file's default resolves the field to
  `null`, same as any other field with no default and nothing from a source. `file({ required:
  true })` additionally narrows `.get()`'s type to `FileBlob` (never `null`), same type-level
  promise `default` makes elsewhere in this package.
- **`load(shape, options?)`** — exported from `@jondotsoy/configs`, identical to `create()` except
  its `options.sources` defaults to `[envSource()]` instead of `[]`, so `load(shape)` alone reads
  straight from `process.env`. Passing an explicit `sources` array overrides that default entirely
  (it does not merge with `envSource()`), at which point `load()` behaves exactly like `create()`.
- **`string()`, `numeric()`, `boolean()`, `url()`, `shape()`** — field-schema builder functions
  exported from `@jondotsoy/configs`, shorthand for `{ type: "string" | "number" | "boolean" |
  "url" | "shape", ... }` object literals (e.g. `numeric({ summary: "HTTP port", default: 3000 })`
  instead of `{ type: "number", summary: "HTTP port", default: 3000 }`). Each accepts the same
  options as its `FieldSchema` variant, minus `type`, and now also a `key?: string | string[]`
  option (see below). They return a new exported `ConfigDescriptor<T>` instance instead of a plain
  object literal; `shape()`'s value type is still inferred from its `schema` option's `parse`
  return type, e.g. `shape({ schema: z.object({ issuer: z.string() }), required: true })`.
- **`url()` / `{ type: "url" }`** — a new field type that parses a string value into a `URL`
  instance (via the built-in `URL` constructor), throwing a `ConfigError` if it isn't a valid URL.
  `url()` resolves to `URL | null` (or `URL` when given a `default`), same as every other field type.
- **`choice(options)`** — a new field-schema builder exported from `@jondotsoy/configs`, for a
  field that must resolve to one of a fixed list of strings, e.g. `choice({ options: ["debug",
  "info", "warn", "error"] })`. Rejects (throwing a `ConfigError`) any value not in `options.options`;
  the field's inferred type narrows to the literal union of `options.options` (e.g. `"debug" |
  "info" | "warn" | "error"`), same as every other builder narrows to `T` (rather than `T | null`)
  once a `default` is given.
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

[1.2.12]: https://github.com/JonDotsoy/configs/releases/tag/v1.2.12
[1.2.6]: https://github.com/JonDotsoy/configs/releases/tag/v1.2.6
[1.2.1]: https://github.com/JonDotsoy/configs/releases/tag/v1.2.1
[1.2.0]: https://github.com/JonDotsoy/configs/releases/tag/v1.2.0
[1.1.4]: https://github.com/JonDotsoy/configs/releases/tag/v1.1.4
[1.1.2]: https://github.com/JonDotsoy/configs/releases/tag/v1.1.2
[1.1.1]: https://github.com/JonDotsoy/configs/releases/tag/v1.1.1
[1.1.0]: https://github.com/JonDotsoy/configs/releases/tag/v1.1.0
[1.0.1]: https://github.com/JonDotsoy/configs/releases/tag/v1.0.1
[1.0.0]: https://github.com/JonDotsoy/configs/releases/tag/v1.0.0
