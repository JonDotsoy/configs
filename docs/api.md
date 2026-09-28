# API reference

## Overview: `create()` and `load()`

Both `create()` and `load()` build a **config node**: a plain object with one
live [`Store`](#store) per field in the shape you pass in, plus `then()`/`await`
support and a `close()` method.

```ts
import { create, string, numeric } from "hotconfigs";
import { envSource } from "hotconfigs/sources/env";

const cfg = create(
  {
    host: string({ default: "localhost" }),
    port: numeric({ default: 3000 }),
  },
  { sources: [envSource()] },
);
```

- **`create(shape, options?)`** builds the node from `options.sources` (default
  `[]` — no sources, so every field only ever gets its `default`, if any).
- **`load(shape, options?)`** is the same thing, except it defaults
  `options.sources` to `[envSource()]`, so a plain `load(shape)` reads straight
  from `process.env`. Passing an explicit `sources` array overrides that
  default entirely (it isn't merged with `envSource()`), and `load()` then
  behaves exactly like `create()`.

`shape` is a plain object whose values are either:

- a **descriptor** (`string()`, `numeric()`, `file()`, ...) — a leaf field;
- a nested plain object — a group, recursed into the same way;
- another `create()`/`load()` result — an **embedded node**, with its own
  independent `sources`, adopted as-is into the tree.

Both calls return synchronously — you don't need to `await` to start reading
fields. Every returned node is:

- **Live immediately.** Each field's `Store` already has a value the moment
  `create()`/`load()` returns (its `default`, or whatever a source published
  synchronously at tick 0) and updates in place as sources open and push
  later snapshots.
- **`Store`-shaped.** Read a field with `.get()`, react to changes with
  `.subscribe()`/`.listen()` — see [`Store`](#store) below.
- **Thenable.** `await cfg` (or `cfg.then(...)`) resolves once every source —
  the node's own, and every embedded node's own — has published its first
  snapshot and every `required` field is confirmed to hold a real value.
  Awaiting narrows each field's type: a `required` field (or one with a
  `default`) is typed `T` instead of `T | null` on the awaited result. If any
  `required` field is still missing, or a field's `start()` reported an error,
  the promise rejects with a `ConfigValidationError` collecting every failure
  across the tree by path.
- **Closable.** `cfg.close()` closes every one of the node's own `sources`,
  every field descriptor's own `close` hook, and every embedded node's own
  `close()`, in one call. Safe to call any number of times, whether or not the
  node has finished opening yet.

```ts
const cfg = create({ port: numeric({ default: 3000, required: true }) }, { sources: [envSource()] });

cfg.port.get(); // number | null — live, right now
const ready = await cfg; // waits for envSource() to open and required checks to pass
ready.port.get(); // number — narrowed, guaranteed

await cfg.close(); // releases envSource() and anything else this node opened
```

### `Store`

Every leaf field (and the `rawStore`/`opened` value a `Source` exposes) is a
`Store<T>`:

- **`.get(): T`** — the current value, synchronously.
- **`.subscribe(fn): () => void`** — calls `fn` immediately with the current
  value, and again on every later change; returns an unsubscribe function.
- **`.listen(fn): () => void`** — same as `.subscribe`, but does **not** call
  `fn` immediately — only on later changes.

## Sources and descriptors

A **`Source`** is where config data comes from: `envSource()`, `fetchSource()`,
`sseSource()`, `fileSource()`, `shellSource()`, `pullSource()`, `literalSource()`.
Each one produces whole-tree (or patch) snapshots asynchronously — reading env
vars, fetching a URL, watching a file, running a command, polling a callback —
and publishes them into the config tree. `options.sources` (an array, passed
to `create()`/`load()`) is where you wire one or more of these in; the first
source in the array whose snapshot has a value at a given field's path wins
over later ones.

A **descriptor** (`string()`, `numeric()`, `boolean()`, `url()`, `list()`,
`shape()`, `choice()`, `file()`) is a leaf field: it declares the field's type, options
(`default`, `required`, `pattern`, ...), and how to parse/coerce the raw value
a source published at that field's path into the field's actual type. Every
descriptor is a real `Descriptor` instance (built by one of these functions,
or by `new Descriptor(...)` directly for a custom field type) — a shape entry
that isn't one is instead treated as a nested group.

## Descriptors

Every descriptor shares these base options (in addition to the ones listed
per descriptor below):

| Option | Type | Description |
| --- | --- | --- |
| `summary` | `string` | Free-form description of the field, for documentation purposes. Not enforced or validated. |
| `required` | `boolean` | Once every source has settled, a `required` field still resolved to `null` is reported as a missing-value error — surfaced through `create()`'s returned node rejecting with a `ConfigValidationError`. Also narrows the field's *awaited* type (after `await cfg`) to exclude `null`. |
| `freeze` | `boolean` | Declared, but currently unused by any engine in this package. |
| `key` | `string \| string[]` | Overrides where this field reads from in each source's snapshot: an explicit path, checked instead of the field's own position in the shape tree (its key, prefixed by every ancestor group's own key). A single string is a one-segment path — `key: "PORT"` reads the source snapshot's top-level `PORT`, regardless of how deeply the field is nested. |

A field with neither `default` nor `required` can genuinely resolve to `null`
forever — that's expected, not an error.

### `string(options?)`

A plain string field.

```ts
string({ pattern: /^(dev|prod)$/, default: "dev" });
```

| Option | Type | Description |
| --- | --- | --- |
| `pattern` | `RegExp` | The raw string must match this pattern, or the field fails to parse (a `ConfigError`, logged or thrown per `required`). |
| `default` | `string` | Fallback used when no source has a value for this field. Also narrows the field's type to exclude `null`, pending and awaited alike. |

Rejects a non-string raw value.

### `numeric(options?)`

A numeric field. A numeric-looking string (`"3000"`) is coerced to a number;
anything else is rejected.

```ts
numeric({ default: 3000 });
```

| Option | Type | Description |
| --- | --- | --- |
| `default` | `number` | Fallback used when no source has a value for this field. Narrows the field's type to exclude `null`. |

### `boolean(options?)`

A boolean field. `"true"`/`"1"` and `"false"`/`"0"` (as strings) are coerced;
anything else is rejected.

```ts
boolean({ default: false });
```

| Option | Type | Description |
| --- | --- | --- |
| `default` | `boolean` | Fallback used when no source has a value for this field. Narrows the field's type to exclude `null`. |

### `url(options?)`

Parses (and validates) a string value into a `URL` instance. An already-`URL`
raw value passes through as-is.

```ts
url({ default: new URL("https://example.com") });
```

| Option | Type | Description |
| --- | --- | --- |
| `default` | `URL` | Fallback used when no source has a value for this field. Narrows the field's type to exclude `null`. |
| `base` | `string \| URL` | Resolves a relative raw value against it (as `new URL(raw, base)` would), instead of requiring an absolute URL. Omitting it falls back to the environment's `location` (e.g. a browser's `window.location`) when one is globally available. |

Rejects a raw value that isn't a string (or `URL`), or that `URL.canParse`
rejects.

### `choice(options)`

Resolves only to one of a fixed, non-empty list of strings — rejects
anything else.

```ts
choice({ options: ["debug", "info", "warn", "error"], default: "info" });
```

| Option | Type | Description |
| --- | --- | --- |
| `options` | `readonly string[]` | **Required.** The fixed list of strings this field is allowed to resolve to. The field's type is the literal union of these strings (e.g. `"debug" \| "info" \| "warn" \| "error"`), not the widened `string`. |
| `default` | one of `options` | Fallback used when no source has a value for this field. Must itself be one of `options` (enforced structurally at the type level). Narrows the field's type to exclude `null`. |

### `list(options?)`

Parses a comma-separated string into a `string[]`. A field wrapped in double
quotes may contain literal commas, and a backslash escapes a single character
outside quotes.

```ts
list({ default: [] });
```

```
1,2,3,4,5                        -> ["1", "2", "3", "4", "5"]
"Foo tar , bios did",tar,1234    -> ["Foo tar , bios did", "tar", "1234"]
Foo\,tar,biz                     -> ["Foo,tar", "biz"]
```

| Option | Type | Description |
| --- | --- | --- |
| `default` | `string[]` | Fallback used when no source has a value for this field. Narrows the field's type to exclude `null`. |
| `delimiter` | `string \| false` | Overrides the split character (`,` by default) — e.g. `delimiter: ";"` for `"a;b;c"` → `["a", "b", "c"]`. Pass `delimiter: false` to skip splitting entirely: a string raw value resolves to a single-element array holding it verbatim (`"a,b,c"` → `["a,b,c"]`) — for a field whose value happens to contain the delimiter but was never meant to be split into a list. |
| `avoidTrim` | `boolean` | Keeps each unquoted field's surrounding whitespace instead of trimming it (`" a , b "` → `[" a ", " b "]`). A quoted field's content is never trimmed either way. |
| `required` | `boolean` | Same base option every descriptor has (see above), but with a `list()`-specific gotcha: an empty raw string resolves to `[]`, not `null`, so a `required` list field fed an empty string is *not* rejected — see the note below. |

An already-`string[]` raw value passes through as-is (each element coerced
via `String(...)`), and a raw `number`/`boolean` is wrapped into a
single-element array (`1` → `["1"]`, `true` → `["true"]`) instead of being
rejected. Rejects anything else (e.g. a plain object).

An empty (or whitespace-only) raw string splits to `[]`, not a single-element
`[""]` — an empty source value means "no items". Note that `required: true`
only guards against a `null` field (no source ever published a value here):
`[]` is a real resolved value, so a `required` list field fed an empty string
resolves to `[]` rather than rejecting; use `pattern`-level validation
(via a custom `Descriptor`) if an empty list must itself be rejected.

### `shape(options?)`

A free-form object field, optionally validated against a schema.

```ts
import { z } from "zod";

shape({ schema: z.object({ host: z.string(), port: z.number() }) });
```

| Option | Type | Description |
| --- | --- | --- |
| `schema` | `Parseable<T>` — any object exposing `parse(value: unknown): T` (e.g. a zod/valibot/superstruct schema) | Validates (and can transform) the raw value; the field's type is inferred from `schema.parse`'s return type. Omitting `schema` passes any object value through as-is (only checked for `typeof value === "object"`), and the field's type is `unknown`. |
| `default` | `V` (inferred from `schema`, or `unknown` without one) | Fallback used when no source has a value for this field. Narrows the field's type to exclude `null`. |

A failure (a non-object raw value with no `schema`, or a `schema.parse` throw)
doesn't tear down the whole config tree by default: it's logged via
`console.error` and the field resolves to `null` — same as a source that
simply doesn't have a value there. Only `required: true` escalates that
failure into a thrown `ConfigError`.

### `file(options?)`

Loads a field's value as a file, decoded into a `FileBlob`. Imported from
`hotconfigs/node` (not the root entry point).

```ts
import { file } from "hotconfigs/node";

file({ default: new URL("file:///etc/ssl/certs/server.pem") });
```

| Option | Type | Description |
| --- | --- | --- |
| `format` | `"text" \| "base64"` | Picks how to decode a source's raw string value (and a string `default`) instead of inferring it. `"text"` encodes it as UTF-8 as-is; `"base64"` decodes it first. Defaults to inferring per-value: a string that looks like base64 is decoded as base64, everything else as text. |
| `default` | `string \| URL` | Fallback used when no source has a value for this field. A `string` is decoded the same way as a source's raw value (per `format`, or inferred). A `file:` `URL` is read from local disk eagerly, right when `file()` is called — if that file doesn't exist, no default is set at all, and the field resolves to `null`. |

A resolved `FileBlob` exposes `.location` (a `file:` `URL` — the default's own
`URL`, or a fresh temp file the decoded content was written to), `.size`,
`.type` (MIME type inferred from `.location`'s extension), and async readers:
`.text()`, `.json()`, `.arrayBuffer()`, `.bytes()`, `.formData()`, `.stream()`.

A decoding failure (a non-string/non-`FileBlob` raw value, or invalid base64)
is logged and resolves to `null`, unless `required` escalates it into a
thrown `ConfigError` — same "log unless required" rule as `shape()`.

## Sources

Every source is created by its own factory function (`envSource()`,
`fetchSource()`, ...) and passed into `create()`/`load()`'s `options.sources`
array. Each one is importable from its own subpath, e.g.
`hotconfigs/sources/env`.

A `Source` created this way exposes `source.metrics` — a plain object of
built-in `Metric`s (`CounterMetric`, `HistogramMetric`, `GaugeMetric` from
`hotconfigs/utils/metrics`) that record request/read counts and
durations, documented per source below.

### `envSource(options?)`

Snapshots environment variables into a config tree, one field per key.

```ts
import { envSource, mapKey } from "hotconfigs/sources/env";

envSource({ prefix: "APP_", mapKey: mapKey.snakeCase() });
```

| Option | Type | Description |
| --- | --- | --- |
| `env` | `Record<string, string \| undefined>` | The env vars to read. Defaults to `process.env`. |
| `prefix` | `string` | Only keys starting with `prefix` are included; the prefix is stripped before `mapKey` runs. |
| `suffix` | `string` | Only keys ending with `suffix` are included; the suffix is stripped before `mapKey` runs. |
| `mapKey` | `(key: string) => string[]` | Maps each (already prefix/suffix-stripped) key to a path into the config tree. Defaults to the identity mapping: `"FOO_TAR" => ["FOO_TAR"]`. |

Built-in `mapKey` strategies (each a factory returning an `EnvKeyMapper`):

- **`mapKey.snakeCase({ separator? })`** — splits a key into a lowercase
  nested path on `separator` (default `"_"`): `"FOO_TAR" => ["foo", "tar"]`.
- **`mapKey.identity()`** — passes each key through unchanged, as a
  single-segment path. Equivalent to the default when `mapKey` is omitted.
- **`mapKey.camelCase()`** — maps a key to a single camelCase segment:
  `"FOO_TAR" => ["fooTar"]`.
- **`mapKey.lookup(table, fallback?)`** — looks a key up in `table` for an
  explicit path (e.g. `mapKey.lookup({ PORT: ["server", "port"] })`), falling
  back to `fallback` (default: identity) for keys not in `table`.

Publishes its snapshot synchronously and closes. Records a `keys`
`GaugeMetric` — how many env vars ended up in the tree after `prefix`/`suffix`
filtering.

### `fetchSource(options)`

Fetches a snapshot from a URL.

```ts
import { fetchSource } from "hotconfigs/sources/fetch";

fetchSource({ url: "https://example.com/features", pollingInterval: 30_000 });
```

| Option | Type | Description |
| --- | --- | --- |
| `url` | `string \| URL` | **Required.** The URL to fetch. |
| `method` | `string` | HTTP method. Defaults to `"GET"`. |
| `headers` | `RequestInit["headers"]` | Passed through to `fetch` as-is. |
| `body` | `RequestInit["body"]` | Request body, passed through to `fetch` as-is. |
| `signal` | `AbortSignal` | Aborts the in-flight fetch (and stops retrying it) when it fires. Only covers a single round — close the `Source` itself to stop polling entirely. |
| `mode` | `RequestInit["mode"]` | Passed through to `fetch` as-is. |
| `cache` | `RequestInit["cache"]` | Passed through to `fetch` as-is. |
| `redirect` | `RequestInit["redirect"]` | Passed through to `fetch` as-is. |
| `credentials` | `HttpFetchCredentials` | Sets the `Authorization` header: `{ basic: { username, password } }` sends `Basic <base64>`; `{ bearer: { token } }` sends `Bearer <token>`. |
| `attempts` | `number` | Attempts before giving up. Defaults to `1` (no retry). |
| `bodyParser` | `(response: Response) => Promise<T>` | Turns the fetched `Response` into `T`. Defaults to `(res) => res.json()`. |
| `acceptStatus` | `(statusCode: number) => boolean` | Decides whether a status code counts as accepted. Defaults to 2xx. |
| `pollingInterval` | `number \| false` | Milliseconds between fetches. Defaults to `false`: fetches once and closes. Set a number to keep fetching on that interval until closed. |
| `followCacheControl` | `boolean` | Follows the response's `Cache-Control` header to decide when to fetch again, instead of (or as a fallback for) `pollingInterval`. `max-age=<seconds>` schedules the next fetch that far out; `no-store`/`no-cache` schedules it immediately. Defaults to `false`. |
| `useConditionalRequests` | `boolean` | Sends a conditional GET on every round after the first (`If-None-Match`/`If-Modified-Since` from the previous response's `ETag`/`Last-Modified`); a `304` reply keeps the store at its last value. Defaults to `true`. |
| `treePath` | `string[]` | Selects a subtree of the fetched body to use as the config tree, e.g. `["containers", "settings"]`. Defaults to `[]` (the whole body). |
| `reduce` | `(incoming: T, previous: T \| null) => T` | Combines each successful fetch with the previously published value instead of replacing it outright. Defaults to a full replace. |
| `onFetched` | `(event: FetchedEvent) => void` | Called once per fetch round with `{ url, ok, statusCode?, durationMs, error? }`. Must not throw. |

A round that never succeeds (network error, or a status rejected by
`acceptStatus`, after exhausting `attempts`) is logged and leaves the store at
its last value (`null` before the first success) instead of throwing.

Records `requests` (`CounterMetric`) and `duration` (`HistogramMetric`,
seconds), both labeled `ok` (`"true"`/`"false"`).

### `sseSource(options)`

Connects to a Server-Sent Events endpoint; every JSON-object message is
applied as a patch onto the accumulated config tree.

```ts
import { sseSource } from "hotconfigs/sources/sse";

sseSource({ url: "https://example.com/events" });
```

| Option | Type | Description |
| --- | --- | --- |
| `url` | `string \| URL` | **Required.** The SSE endpoint to connect to. |
| `method` | `string` | HTTP method. Defaults to `"GET"`. |
| `headers` | `RequestInit["headers"]` | Passed through to `fetch` as-is. |
| `body` | `RequestInit["body"]` | Request body, passed through to `fetch` as-is. |
| `signal` | `AbortSignal` | Aborts the connection (and stops retrying it) when it fires. Independent of the `Source`'s own `close()`, which also aborts. |
| `mode` | `RequestInit["mode"]` | Passed through to `fetch` as-is. |
| `cache` | `RequestInit["cache"]` | Passed through to `fetch` as-is. |
| `redirect` | `RequestInit["redirect"]` | Passed through to `fetch` as-is. |
| `credentials` | `HttpFetchCredentials` | Same as `fetchSource`'s `credentials`. |
| `attempts` | `number` | Attempts to establish the connection before giving up. Defaults to `1`. Once the stream is open, a dropped connection closes the source rather than reconnecting. |
| `acceptStatus` | `(statusCode: number) => boolean` | Decides whether a status code counts as accepted. Defaults to 2xx. |
| `reduce` | `(incoming: T, previous: T \| null) => T` | Combines each parsed message with the config tree accumulated so far, overriding the default shallow patch-merge. Takes precedence over `overwrite`. |
| `overwrite` | `boolean` | Replaces the accumulated tree wholesale with each parsed message instead of shallow patch-merging it. Ignored when `reduce` is set. Defaults to `false`. |

A message that isn't valid JSON, or doesn't parse to a plain object, is
logged and skipped without disturbing the accumulated state or the
connection. `start()` only resolves once the first message has been applied
(or the connection closed without ever receiving one).

Records `connections`/`connectionDuration` (for the initial connection) and
`messages` (per SSE message), all labeled `ok`.

### `fileSource(path, options?)`

Reads a config tree from a local file — `.json` or `.env` by default (matched
by extension, or a bare `.env` filename), live via `fs.watch`.

```ts
import { fileSource } from "hotconfigs/sources/file";

fileSource(".env");
fileSource("./config.json", { treePath: ["server"] });
```

| Option | Type | Description |
| --- | --- | --- |
| `watch` | `boolean \| { interval: number }` | Republishes the config tree whenever the file changes. Defaults to `true` (`fs.watch`). Pass `{ interval: <ms> }` to poll and re-read unconditionally instead — useful where `fs.watch` doesn't fire reliably (e.g. some network mounts). `false` reads once and closes. |
| `treePath` | `string[]` | Selects a subtree of the parsed file to use as the config tree. Defaults to `[]` (the whole file). |
| `format` | `"json" \| "env"` | Picks which built-in parser to use, overriding extension-based detection. Ignored when `parser` is set. |
| `parser` | `(buffer: Uint8Array) => unknown` | Overrides the default parsing entirely — receives the file's raw bytes and returns the parsed tree. Use it for a format this module doesn't parse itself (e.g. YAML). |
| `reduce` | `(incoming: T, previous: T \| null) => T` | Combines each read with the previously published value instead of replacing it outright. Defaults to a full replace. |

A read or parse failure is logged and leaves the store at its last value
(`null` before the first successful read) instead of throwing.

Records `reads` (`CounterMetric`) and `readDuration` (`HistogramMetric`,
seconds), both labeled `ok`.

### `shellSource(args, options?)`

Runs `args` as a child process and publishes its parsed stdout as the config
tree.

```ts
import { shellSource } from "hotconfigs/sources/shell";

shellSource(["gh", "auth", "token", "--format", "json"]);
```

| Option | Type | Description |
| --- | --- | --- |
| `cwd` | `string` | Working directory for the spawned process. Defaults to the current process's cwd. |
| `env` | `Record<string, string \| undefined>` | Environment variables for the spawned process. Defaults to the current process's own env. |
| `signal` | `AbortSignal` | Kills the in-flight run (and stops retrying it) when it fires. Only covers a single round — close the `Source` itself to stop polling entirely. |
| `attempts` | `number` | Runs to attempt before giving up. Defaults to `1`. Only a failure to run the process at all (e.g. the binary doesn't exist) is retried — a rejected exit code or an abort throws immediately. |
| `stdoutParser` | `(stdout: string) => T \| Promise<T>` | Turns the process's stdout (decoded as UTF-8) into `T`. Defaults to `JSON.parse`. |
| `acceptExitCode` | `(exitCode: number) => boolean` | Decides whether an exit code counts as accepted. Defaults to `(exitCode) => exitCode === 0`. |
| `treePath` | `string[]` | Selects a subtree of the parsed stdout to use as the config tree. Defaults to `[]` (the whole output). |
| `pollingInterval` | `number \| false` | Milliseconds between runs. Defaults to `false`: runs once and closes. |
| `reduce` | `(incoming: T, previous: T \| null) => T` | Combines each successful run with the previously published value instead of replacing it outright. Defaults to a full replace. |
| `onRun` | `(event: ShellRunEvent) => void` | Called once per run with `{ args, ok, exitCode?, stderr?, durationMs, error? }`. Must not throw. |

A run whose exit code is rejected, or whose stdout fails to parse, is logged
and swallowed (leaving the store at its last value) instead of thrown.

Records `runs` (`CounterMetric`) and `duration` (`HistogramMetric`, seconds),
both labeled `ok`.

### `pullSource(options)`

Calls a callback on a fixed interval and publishes whatever it returns.

```ts
import { pullSource } from "hotconfigs/sources/pull";

pullSource({ pull: () => secretsManager.getSecretValue("prod/db"), interval: 5 * 60_000 });
```

| Option | Type | Description |
| --- | --- | --- |
| `pull` | `() => T \| Promise<T>` | **Required.** Called on every round to produce a fresh snapshot. May be sync or async. Called once immediately when the source starts, then again every `interval`. |
| `interval` | `number` | **Required.** Milliseconds between calls to `pull`. |

A `pull` failure is logged and swallowed. If the very first call fails, the
source closes with an empty (`null`) store; a failure on a later round is
logged and skipped, keeping the last good value and the polling running.

Records `pulls` (`CounterMetric`) and `pullDuration` (`HistogramMetric`,
seconds), both labeled `ok`.

### `literalSource(value)`

Publishes a single static `value` immediately, then closes. Useful for
hardcoded defaults, a static fallback tree, or tests.

```ts
import { literalSource } from "hotconfigs/sources/literal";

literalSource({ host: "localhost", port: 3000 });
```

Takes the value directly — no options object.

## Writing a custom descriptor

A descriptor is a real `Descriptor` instance — every shape entry that isn't
one (and isn't a nested `create()` node) is treated as a plain nested group
instead, so a hand-written field type has to go through `new Descriptor(...)`,
same as every built-in builder does.

```ts
import { Descriptor, type Settled, type WithDefault } from "hotconfigs";

interface PortFieldOptions {
  key?: string | string[];
  required?: boolean;
  default?: number;
}

function port<const O extends PortFieldOptions = {}>(
  options?: O,
): Descriptor<WithDefault<O, number>, Settled<O, number>> {
  const opts = (options ?? {}) as O;
  const defaultValue = opts.default !== undefined ? opts.default : (null as unknown as number);

  return new Descriptor<number, number>({
    type: "port",
    options: opts,
    start(control) {
      control.rawStore.subscribe((raw) => {
        if (raw === undefined || raw === null) {
          control.set(defaultValue);
          return;
        }
        const num = Number(raw);
        if (typeof raw !== "string" || raw.trim() === "" || Number.isNaN(num) || num <= 0) {
          control.error(new Error(`Expected a positive port number at "${control.path.join(".")}"`));
          return;
        }
        control.set(num);
      });
    },
  }) as Descriptor<WithDefault<O, number>, Settled<O, number>>;
}
```

- **`start(control)`** runs exactly once per field, synchronously, when
  `create()`/`load()` builds that field — before any source has opened.
  `control.rawStore` is this field's live raw value, already merged across
  every `options.sources` entry by priority (read-only:
  `.get()`/`.subscribe()`/`.listen()`). Subscribing to it is what makes the
  field live: the subscriber fires immediately with the current raw value
  (tick 0) and again on every later change. A `start` that never subscribes
  (or sets up nothing else of its own) leaves the field frozen forever —
  there's no error or warning for it.
- **`control.set(value)`** publishes the field's next typed value —
  callable synchronously inside `start` and/or any number of times later,
  from a `rawStore` subscriber, a timer, a resolved promise, whatever `start`
  sets up. It's the only thing that ever updates the field.
- **`control.error(error)`** reports a failure for this field without
  tearing down the rest of the tree — `create()` collects every field's
  errors by path and surfaces them together as a `ConfigValidationError` once
  the node settles. A `start` that throws instead is caught and forwarded the
  same way, so either style works.
- **`close()`** (optional, on the constructor — not `control.close()`,
  which doesn't exist on `Descriptor`) releases whatever `start` set up (a
  timer, a subscription); `create()`'s own `close()` calls it once per field.
- There's no `reduce()` on `Descriptor` (unlike `Source`): a field's
  `start` always works from one already-merged `rawStore`, so any combining
  logic — falling back to a default, comparing against a previous value —
  belongs directly inside the `rawStore.subscribe()` callback.
- `WithDefault<O, T>`/`Settled<O, T>` (exported from the package root) are
  the same helpers every built-in builder uses to compute `Descriptor`'s two
  type parameters from `O`: `WithDefault` narrows the *pending* type (before
  `await`) to exclude `null` when `O` has a `default`; `Settled` narrows the
  *awaited* type the same way, plus when `O` has `required: true`. A
  hand-written descriptor isn't obligated to use them — a fixed
  `Descriptor<number, number>` also compiles, it just never types `.get()`
  as `number | null` regardless of `options`.

See [`docs/develop/custom-source-and-descriptor.md`](./develop/custom-source-and-descriptor.md)
for the full contract, more patterns (a non-scalar field type, a field with
its own timer independent of any source), and common mistakes.

## Writing a custom source

A `Source<T>` wraps an `UnderlyingSource<T>` — same `start`/`close` shape as
a descriptor, but for a whole config tree instead of a single field, plus an
optional `reduce` for sources that only ever produce partial patches.

```ts
import { Source } from "hotconfigs";

function pollingSource(url: string, intervalMs: number): Source<{ port: number }> {
  let timer: ReturnType<typeof setInterval>;

  return new Source({
    async start(control) {
      const poll = async () => control.set((await (await fetch(url)).json()) as { port: number });
      await poll(); // first value before open() resolves
      timer = setInterval(poll, intervalMs);
    },
    close() {
      clearInterval(timer);
    },
  });
}
```

- **`start(control)`** runs exactly once per `Source`. `control.set(value)`
  publishes the tree's next snapshot — callable once (a static source like
  `literalSource`) or any number of times later (a live source like
  `sseSource`/`fileSource`). `source.open()` — what `create()` awaits to wire
  this source into the tree — resolves once `start()` itself finishes
  running, **not** once the first `control.set()` has fired: a `start` that
  only arms a timer and returns immediately makes `open()` resolve with the
  store still empty. To make `await cfg` wait for a real first value (as
  `pollingSource` above and every built-in polling/watching source do),
  `start` has to stay in an `await` until that first `control.set()` has run.
- **`close()`** (optional) releases whatever `start` set up — a timer, an
  in-flight connection, a watcher. `Source.close()` calls it at most once,
  whether triggered from inside `start` (via `control.close()`, a pure
  signal with no effect of its own) or from the outside, and is safe to call
  any number of times.
- **`reduce(incoming, previous)`** (optional) is for a source whose `start`
  can only ever hand `control.set()` a partial patch instead of a whole
  snapshot (e.g. one SSE message). Every `control.set(value)` runs through it
  first — `previous` is `null` before the first call — and its return value
  is what actually gets published. Without `reduce`, every `control.set()`
  replaces the tree outright; see `sseSource`'s default shallow patch-merge
  for a worked example.
- **`metrics`** (optional) is a plain `Record<string, Metric>`
  (`CounterMetric`/`HistogramMetric`/`GaugeMetric`, from
  `hotconfigs/utils/metrics`) bumped from inside `start`/`close` and
  exposed as-is on the returned `Source` via `source.metrics` — the same
  pattern every built-in source (`envSource`, `fetchSource`, ...) uses for
  its own request/read counters.

See [`docs/develop/custom-source-and-descriptor.md`](./develop/custom-source-and-descriptor.md)
for the full contract, more patterns (cleaning up a connection/timer in
`close()`, patch vs. full-snapshot `reduce`), and common mistakes.
