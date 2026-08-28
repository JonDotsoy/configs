# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.0]: https://github.com/JonDotsoy/configs/releases/tag/v1.0.0
