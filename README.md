# @jondotsoy/configs

Ship your config to your apps, fast. Configuration isn't just static values
read once at boot anymore — feature flags, remote toggles, and settings
served over HTTP or SSE change at runtime to turn features on and off or
adjust app behavior without a redeploy. `@jondotsoy/configs` is built for
that: every field is a live `Store` you subscribe to, so your app reacts
the moment a source pushes a new value.

- **Reactive configs** — every field is a live `Store`; subscribe to it and get notified whenever an upstream source changes.
- **Lightweight** — no dependencies, just a thin layer over plain objects and stores.
- **Typed with TS check** — schemas are statically checked, so `cfg.port.get()` is inferred as `number | null` (or `number` when a `default` is set), not `any`.

```ts
import { create } from "@jondotsoy/configs";
import { envSource, mapKey } from "@jondotsoy/configs/sources/env";
import { fetchSource } from "@jondotsoy/configs/sources/fetch";

// SERVER_PORT=3000 SERVER_HOST=localhost → { server: { port: "3000", host: "localhost" } }
// GET https://example.com/features → { promoService: true } (polled every 30s)
const cfg = await create({
  server: create(
    {
      port: { type: "number", summary: "HTTP port", default: 3000 },
      host: { type: "string", summary: "bind host", default: "localhost" },
    },
    { sources: [envSource({ mapKey: mapKey.snakeCase() })] },
  ),
  features: create(
    {
      promoService: { type: "boolean", summary: "enable the promo service", default: false },
    },
    { sources: [fetchSource({ url: "https://example.com/features", pollingInterval: 30_000 })] },
  ),
});

// React to changes
cfg.server.port.subscribe((port) => {
  console.log(`listening on port ${port}`);
});

cfg.features.promoService.subscribe((enabled) => {
  console.log(`promo service ${enabled ? "enabled" : "disabled"}`);
});

console.log(cfg.server.port.get());
// 3000
```

## Table of contents

- [Install](#install)
- [Guide](#guide)
  - [Field types](#field-types)
  - [`Source` — building a custom source](#source--building-a-custom-source)
  - [`envSource` — environment variables](#envsource--environment-variables)
  - [`fetchSource` — a JSON endpoint over HTTP](#fetchsource--a-json-endpoint-over-http)
  - [`sseSource` — live updates over Server-Sent Events](#ssesource--live-updates-over-server-sent-events)
  - [`fileSource` — a local `.json` or `.env` file](#filesource--a-local-json-or-env-file)
  - [`pullSource` — calling a function on an interval](#pullsource--calling-a-function-on-an-interval)
  - [`literalSource` — a static value](#literalsource--a-static-value)
  - [Reacting to changes — restarting a periodic task](#reacting-to-changes--restarting-a-periodic-task)
  - [`useConfig` — reading a field in React](#useconfig--reading-a-field-in-react)
  - [Closing a config tree](#closing-a-config-tree)

## Install

```sh
npm install @jondotsoy/configs
```

## Guide

### Field types

A field's `type` is `"string"`, `"number"`, `"boolean"`, or `"shape"`. The first three coerce and
validate primitives (numeric/boolean-ish strings, an optional `pattern` for strings). `"shape"`
hands the raw value to a `schema` you provide — anything with a `parse(value: unknown): T` method,
which is exactly the shape `zod`, `valibot`, and most other validation libraries already export —
so there's no dependency on any specific one:

```ts
import { create } from "@jondotsoy/configs";
import { z } from "zod";

const cfg = await create(
  {
    jwt: { type: "shape", schema: z.object({ issuer: z.string(), ttl: z.number() }) },
  },
  { sources: [/* ... */] },
);

// cfg.jwt.get() is typed as { issuer: string; ttl: number } | null — inferred from `schema.parse`'s
// return type, no manual annotation needed.
```

A value that fails to parse doesn't take down the whole config tree by default — data comes from
sources outside this package's control, so a `schema.parse` failure (or, with no `schema`, any
non-object value) is logged via `console.error` and the field resolves to `null`, same as a source
that simply doesn't have it. Set `required: true` to escalate that failure into a thrown
`ConfigError` instead:

```ts
const cfg = await create(
  { jwt: { type: "shape", schema: z.object({ issuer: z.string() }), required: true } },
  { sources: [/* a source publishing an invalid jwt throws instead of logging */] },
);
```

`schema` itself is optional — `{ type: "shape" }` alone just passes the raw value through as-is,
rejecting (per the same log-or-throw rule above) anything that isn't an object:

```ts
const cfg = await create({ metadata: { type: "shape" } }, { sources: [/* ... */] });
// cfg.metadata.get() is typed as unknown | null
```

A schema can also be used directly as a shape entry, skipping `{ type: "shape", schema }`:

```ts
const cfg = await create({ port: z.number() }, { sources: [/* ... */] });
// cfg.port.get() is typed as number | null — same as { port: { type: "shape", schema: z.number() } }
```

This shorthand has no room for `summary`/`required`/`readonly`/`default` — so a bad value here
always logs and resolves to `null`. Reach for the explicit `{ type: "shape", schema }` form when
you need `required: true` (or any of the others).

`type` can also just be omitted from that explicit form — `{ schema: z.number() }` behaves exactly
like `{ type: "shape", schema: z.number() }`, `required` included:

```ts
const cfg = await create(
  { port: { schema: z.number(), required: true } },
  { sources: [/* ... */] },
);
// same as { port: { type: "shape", schema: z.number(), required: true } }
```

### `Source` — building a custom source

The building block behind `envSource`, `fetchSource`, `sseSource`, `fileSource`, `pullSource`, and
`literalSource`. It takes an
object with `start(control)` and an optional `close()`, mirroring `ReadableStream`'s
`UnderlyingSource`: `start` runs once and pushes snapshots via `control.set(value)`, while `close`
— called from within `start` via `control.close()`, or from the outside via the `Source`'s own
`close()` — is where you release whatever `start` set up, like a timer or an in-flight request.

```ts
import { Source } from "@jondotsoy/configs";

function pollingSource(url: string, intervalMs: number): Source<{ port: number }> {
  let timer: ReturnType<typeof setInterval>;

  return new Source({
    async start(control) {
      const poll = async () => control.set((await (await fetch(url)).json()) as { port: number });
      await poll();
      timer = setInterval(poll, intervalMs);
    },
    close() {
      clearInterval(timer);
    },
  });
}
```

An optional `reduce(incoming, previous)` runs every `control.set(incoming)` call through it (along
with the last published value, `null` before the first `set()`) instead of publishing `incoming`
as-is — so a source whose `start()` only ever produces a partial patch (like `sseSource`, which
hands `control.set` one SSE message at a time) can publish the merged result without keeping its
own accumulator variable around:

```ts
import { Source } from "@jondotsoy/configs";

const source = new Source<{ port?: number; host?: string }>({
  start(control) {
    control.set({ port: 3000 });   // -> reduce({ port: 3000 }, null)
    control.set({ host: "x" });    // -> reduce({ host: "x" }, { port: 3000 })
  },
  reduce: (patch, previous) => ({ ...(previous ?? {}), ...patch }),
});
// published: { port: 3000, host: "x" }
```

### `envSource` — environment variables

Reads `process.env` (or any object you pass as `env`) into the config tree. `mapKey` decides how
each key maps to a path; the default is the identity mapping, `"FOO_TAR" => ["FOO_TAR"]`.

**Options (`EnvSourceOptions`):**

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `env` | `Record<string, string \| undefined>` | `process.env` | The env vars to read. |
| `prefix` | `string` | — | Only keys starting with `prefix` are included; the prefix is stripped before `mapKey` runs. |
| `suffix` | `string` | — | Only keys ending with `suffix` are included; the suffix is stripped before `mapKey` runs. |
| `mapKey` | `EnvKeyMapper` | identity mapping (`"FOO_TAR" => ["FOO_TAR"]`) | Maps each (already prefix/suffix-trimmed) key to a path into the config tree. |

```ts
import { envSource } from "@jondotsoy/configs/sources/env";

// APP_PORT=3000 OTHER_VAR=x → { port: "3000" } (prefix stripped, OTHER_VAR excluded)
const source = envSource({ prefix: "APP_", mapKey: (key) => [key.toLowerCase()] });
```

Built-in strategies live under the `mapKey` namespace, each a factory returning an `EnvKeyMapper`:

- **`mapKey.snakeCase(options?)`** — splits a `SCREAMING_SNAKE_CASE` key into a lowercase nested
  path on `separator` (default `"_"`): `"FOO_TAR" => ["foo", "tar"]`. Pass a different `separator`
  (e.g. `"__"`) to keep a single underscore inside a segment from splitting it:
  `mapKey.snakeCase({ separator: "__" })` maps `"API_KEY_V2__ENABLED"` to
  `["api_key_v2", "enabled"]` instead of splitting on every `_`.
- **`mapKey.identity()`** — passes each key through unchanged, as a single-segment path:
  `"FOO_TAR" => ["FOO_TAR"]`. Same as omitting `mapKey`, spelled out explicitly.
- **`mapKey.camelCase()`** — maps a key to a single camelCase segment instead of nesting it:
  `"FOO_TAR" => ["fooTar"]`.
- **`mapKey.lookup(table, fallback?)`** — maps specific keys to explicit paths via a
  `Record<string, string[]>` lookup table; a key not in `table` falls back to `fallback` (default:
  the identity mapping). Handy when most keys follow no consistent naming, or when a few need an
  exception to whatever strategy the rest use.

```ts
import { envSource, mapKey } from "@jondotsoy/configs/sources/env";

// SERVER_PORT=3000 SERVER_HOST=localhost → { server: { port: "3000", host: "localhost" } }
const source = envSource({ mapKey: mapKey.snakeCase() });

// PORT=3000 HOST=localhost → { server: { port: "3000" }, HOST: "localhost" }
const source2 = envSource({ mapKey: mapKey.lookup({ PORT: ["server", "port"] }) });
```

You can also pass your own `EnvKeyMapper` instead of a built-in strategy — it's just a
`(key: string) => string[]` function:

```ts
import { envSource } from "@jondotsoy/configs/sources/env";

const source = envSource({
  mapKey: (key) => (key === "PORT" ? ["server", "port"] : [key]),
});
```

### `fetchSource` — a JSON endpoint over HTTP

Fetches a JSON snapshot from `url` (with `method` and `headers`, if needed). Only JSON is
supported — a non-JSON `Content-Type` still gets a fallback parse attempt. `attempts` retries the
download on a network error or a non-`ok` response (default `1`, no retry). If the download never
succeeds, or the body isn't valid JSON, it logs a `console.error` and leaves the store empty
instead of throwing.

`pollingInterval` controls whether `fetchSource` keeps re-fetching `url` over time. **It's off by
default** (`false`): `fetchSource` fetches `url` exactly once and closes, same as if the option
were never set. Pass a number of milliseconds to turn polling on — `fetchSource` then keeps
fetching `url` on that interval (each round still retried up to `attempts` times), updating the
store on every successful fetch, until the `Source` is closed. A failed round after the first one
is logged and skipped, without closing the source or stopping the polling.

**Options (`FetchSourceOptions<T>`):**

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | `string \| URL` | *required* | The endpoint to fetch. |
| `method` | `string` | `"GET"` | HTTP method for the request. |
| `headers` | `RequestInit["headers"]` | — | Request headers, passed through to `fetch` as-is. |
| `body` | `RequestInit["body"]` | — | Request body, passed through to `fetch` as-is (e.g. a JSON string, `FormData`, `Blob`). |
| `signal` | `AbortSignal` | — | Aborts the in-flight fetch (and stops retrying it) when it fires. Covers a single round only — with `pollingInterval` set, later rounds still run; close the `Source` itself to stop polling entirely. |
| `mode` | `RequestInit["mode"]` | — | Passed through to `fetch` as-is. |
| `cache` | `RequestInit["cache"]` | — | Passed through to `fetch` as-is. |
| `redirect` | `RequestInit["redirect"]` | — | Passed through to `fetch` as-is. |
| `credentials` | `HttpFetchCredentials` | — | Sets the `Authorization` header up front instead of adding it to `headers` yourself: `{ basic: { username, password } }` sends `Basic <base64>`; `{ bearer: { token } }` sends `Bearer <token>`. |
| `attempts` | `number` | `1` (no retry) | Attempts to download the data before giving up, on a network error or a non-`ok` response. |
| `bodyParser` | `(response: Response) => Promise<T>` | `(res) => res.json()` | Turns the fetched `Response` into `T`. |
| `acceptStatus` | `(statusCode: number) => boolean` | 2xx: `(status) => status >= 200 && status < 300` | Decides whether a response's status code counts as accepted. A rejected status stops retrying immediately, same as a `bodyParser` failure. |
| `pollingInterval` | `number \| false` | `false` (off) | Milliseconds between fetches. `false` fetches `url` once and closes; a number keeps fetching on that interval (each round retried up to `attempts` times) until the `Source` is closed. |
| `treePath` | `string[]` | `[]` (whole body) | Selects a subtree of the fetched body to use as the config tree, e.g. `["containers", "settings"]`. Applied on every round, including polled ones. Same behavior as `fileSource`'s option of the same name. |
| `reduce` | `(incoming: T, previous: T \| null) => T` | publishes `incoming` as-is (full replace) | Combines each successful fetch with the previously published value instead of replacing it outright. Especially useful with `pollingInterval`, when a later round's response is a partial update. Receives the `treePath`-selected body. |

```ts
import { fetchSource } from "@jondotsoy/configs/sources/fetch";
import { Temporal } from "temporal-polyfill";

const source = fetchSource<{ port: number }>({
  url: "https://config-service.internal/app",
  method: "GET",
  headers: { authorization: `Bearer ${process.env.CONFIG_TOKEN}` },
  attempts: 3,
  // Off by default — pass a number of milliseconds to poll instead of fetching once.
  pollingInterval: Temporal.Duration.from({ seconds: 30 }).total("milliseconds"),
});
```

```ts
import { fetchSource } from "@jondotsoy/configs/sources/fetch";

// each round only returns the fields that changed — merge into what's already there
const source = fetchSource<Record<string, unknown>>({
  url: "https://config-service.internal/app/changes",
  pollingInterval: 30_000,
  reduce: (incoming, previous) => ({ ...(previous ?? {}), ...incoming }),
});
```

```ts
import { fetchSource } from "@jondotsoy/configs/sources/fetch";

const source = fetchSource<{ port: number }>({
  url: "https://config-service.internal/app",
  credentials: { bearer: { token: process.env.CONFIG_TOKEN! } },
  acceptStatus: (status) => status === 200,
});
```

### `sseSource` — live updates over Server-Sent Events

Connects to an SSE endpoint (`url`, `method`, `headers`). Every message tries to parse as JSON and,
if it's a plain object, is applied as a **patch** on top of what was already received — fields add
up and overwrite, the tree is never replaced wholesale by default. Set `overwrite: true` (or pass
a custom `reduce`) to replace the tree wholesale with each message instead:

**Options (`SseSourceOptions`):** the same request-shaping surface as `fetchSource`, minus
`bodyParser` and `pollingInterval` (a persistent connection, not a repeated request), plus
`attempts` retries only the initial connection — once the stream is open, a dropped connection
closes the source rather than reconnecting.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | `string \| URL` | *required* | The SSE endpoint to connect to. |
| `method` | `string` | `"GET"` | HTTP method for the request. |
| `headers` | `RequestInit["headers"]` | — | Request headers, passed through to `fetch` as-is. |
| `body` | `RequestInit["body"]` | — | Request body, passed through to `fetch` as-is (e.g. a JSON string, `FormData`, `Blob`). |
| `signal` | `AbortSignal` | — | Aborts the connection (and stops retrying it) when it fires. Independent of the `Source`'s own `close()`, which also aborts the connection. |
| `mode` | `RequestInit["mode"]` | — | Passed through to `fetch` as-is. |
| `cache` | `RequestInit["cache"]` | — | Passed through to `fetch` as-is. |
| `redirect` | `RequestInit["redirect"]` | — | Passed through to `fetch` as-is. |
| `credentials` | `HttpFetchCredentials` | — | Sets the `Authorization` header up front instead of adding it to `headers` yourself: `{ basic: { username, password } }` sends `Basic <base64>`; `{ bearer: { token } }` sends `Bearer <token>`. |
| `attempts` | `number` | `1` (no retry) | Attempts to establish the connection before giving up. |
| `acceptStatus` | `(statusCode: number) => boolean` | 2xx: `(status) => status >= 200 && status < 300` | Decides whether a response's status code counts as accepted. |
| `reduce` | `(incoming: T, previous: T \| null) => T` | shallow patch-merge (see below) | Combines each parsed message with the tree accumulated so far. Overrides the default patch-merge (and `overwrite`) entirely — a custom `reduce` must do its own merging if that's still wanted. |
| `overwrite` | `boolean` | `false` | Replaces the tree wholesale with each parsed message instead of shallow patch-merging it. Ignored when `reduce` is set. |

```ts
import { sseSource } from "@jondotsoy/configs/sources/sse";

const source = sseSource<{ port?: number; host?: string }>({
  url: "https://config-service.internal/app/events",
});

// message: {"port":3000}       => Store<{ port: 3000 }>
// message: {"host":"10.0.0.1"} => Store<{ port: 3000, host: "10.0.0.1" }>
```

```ts
import { sseSource } from "@jondotsoy/configs/sources/sse";

// each message is a full snapshot, not a patch — replace instead of merging
const source = sseSource<{ port: number }>({
  url: "https://config-service.internal/app/events",
  overwrite: true,
});

// message: {"port":3000}       => Store<{ port: 3000 }>
// message: {"host":"10.0.0.1"} => Store<{ host: "10.0.0.1" }>  (port is gone)
```

```ts
import { sseSource } from "@jondotsoy/configs/sources/sse";

const source = sseSource<{ port?: number; host?: string }>({
  url: "https://config-service.internal/app/events",
  credentials: { bearer: { token: process.env.CONFIG_TOKEN! } },
  attempts: 3,
});
```

A message that isn't valid JSON, or doesn't parse to a plain object, is logged via
`console.error` and skipped — it never resets what was already received.

Opening the source waits for the first message (so the `Store` you get back already has data,
not `null`), then keeps the connection alive in the background, applying further messages as
patches until the resource closes the stream.

### `fileSource` — a local `.json` or `.env` file

Reads a config tree from `path`, parsed by its extension: `.json` or `.env` (matched by extension,
or by the bare `.env` filename itself — a `.env` file always parses to a flat string map, one
entry per `KEY=VALUE` line, blank lines and `#`-comments skipped; anything else is parsed as JSON).
`watch` defaults to `true`: the file is re-read and the store updated live on every change;
`watch: false` reads it once. A missing file or a parse failure (including on a later watched
change) is logged via `console.error` and leaves the store empty instead of throwing — a parse
error on a later change keeps the last good value instead.

`fileSource(path, options?)` takes `path` (a `string` or a `file:` `URL`, e.g.
`new URL("./config.json", import.meta.url)`) as its first argument, and the following as its
second (`FileSourceOptions`):

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `watch` | `boolean` | `true` | Republishes the config tree whenever the file changes on disk. `false` reads it once and closes. |
| `treePath` | `string[]` | `[]` (whole file) | Selects a subtree of the parsed file to use as the config tree, e.g. `["containers", "settings"]`. |
| `format` | `"json" \| "env"` | detected from `path`'s extension (`.env`, `"json"` otherwise) | Picks which built-in parser to use, overriding extension-based detection. Ignored once `parser` is set. |
| `parser` | `(buffer: Uint8Array) => unknown` | decodes as UTF-8 and parses per `format`/detected format | Overrides the default parsing entirely — receives the file's raw bytes and returns the parsed tree, so `fileSource` can support formats it doesn't parse itself (like YAML). |
| `reduce` | `(incoming: T, previous: T \| null) => T` | publishes `incoming` as-is (full replace) | Combines each read with the previously published value instead of replacing it outright. Especially useful with `watch`, when a later read is a partial update. Receives the `treePath`-selected tree. |

```ts
import { fileSource } from "@jondotsoy/configs/sources/file";

const source = fileSource<{ port: number; host: string }>("./config.json");
// config.json: { "port": 3000, "host": "localhost" }
```

`format` picks the built-in parser explicitly (`"json"` or `"env"`) instead of relying on `path`'s
extension — handy for an extensionless path:

```ts
const source = fileSource("./config", { format: "env" });
```

`parser` overrides the default parsing entirely: it receives the file's raw bytes and its return
value is used as the parsed tree, so `fileSource` can support formats it doesn't parse itself
(like YAML) without a hard dependency on a YAML library. `format` is ignored once `parser` is set:

```ts
import { fileSource } from "@jondotsoy/configs/sources/file";
import YAML from "yaml";

const source = fileSource("./config.yaml", {
  parser: (bytes) => YAML.parse(new TextDecoder().decode(bytes)),
});
```

`treePath` selects a subtree of the parsed file to use as the config tree instead of the whole
thing, e.g. to pull just `containers.settings` out of a larger file shared with other tools:

```ts
import { fileSource } from "@jondotsoy/configs/sources/file";

// file.json: { "containers": { "settings": { "port": 3000 } }, "metadata": {...} }
const source = fileSource<{ port: number }>("./file.json", {
  treePath: ["containers", "settings"],
});
```

`reduce` combines each read with the previously published value instead of replacing it
outright — handy with `watch` (the default) when the file is only ever appended to with partial
updates rather than rewritten as a full snapshot each time:

```ts
import { fileSource } from "@jondotsoy/configs/sources/file";

const source = fileSource<Record<string, unknown>>("./config.json", {
  reduce: (incoming, previous) => ({ ...(previous ?? {}), ...incoming }),
});
```

### `pullSource` — calling a function on an interval

Calls `pull` and publishes whatever it returns as the next snapshot — once immediately, then again
every `interval` milliseconds until the `Source` is closed. `pull` can be sync or async, so it's a
general-purpose escape hatch for any input that isn't already covered by a built-in source (a
database query, a cloud secrets manager, a gRPC call, ...). A `pull` failure is logged via
`console.error` and swallowed instead of thrown: on the first call this leaves the store empty
(same as `fetchSource`); on a later call it's skipped, keeping the last good value and the polling
running.

**Options (`PullSourceOptions<T>`):**

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `pull` | `() => T \| Promise<T>` | *required* | Called on every round to produce a fresh snapshot. May be sync or async. |
| `interval` | `number` | *required* | Milliseconds between calls to `pull`. |

```ts
import { pullSource } from "@jondotsoy/configs/sources/pull";
import { Temporal } from "temporal-polyfill";

const source = pullSource<{ port: number }>({
  pull: async () => fetchPortFromSomewhere(),
  interval: Temporal.Duration.from({ seconds: 30 }).total("milliseconds"),
});
```

### `literalSource` — a static value

Publishes a plain, already-in-hand value as a snapshot immediately, then closes. No I/O, no
options — just wraps `value` in a `Source` so it can sit in a `sources` array alongside the rest.
Handy as a static fallback tree (put it last so real sources win), a hardcoded default for a
single environment, or a stand-in source in a test.

**Options:** none — `literalSource(value)` takes only the value to publish, as its single argument.

```ts
import { configs } from "@jondotsoy/configs";
import { envSource, mapKey } from "@jondotsoy/configs/sources/env";
import { literalSource } from "@jondotsoy/configs/sources/literal";

const cfg = await configs.create(
  {
    port: { type: "number", required: true },
    host: { type: "string", required: true },
  },
  {
    sources: [
      envSource({ mapKey: mapKey.snakeCase() }),
      literalSource({ port: 3000, host: "localhost" }), // fallback if env vars are unset
    ],
  },
);
```

### Reacting to changes — restarting a periodic task

Because every field is a live `Store`, `.subscribe()` is the hook point for keeping something
else in sync with the config — for example, restarting a `setInterval` job whenever its period
changes. This only really happens at runtime with a live source like `sseSource`; an
`envSource` resolves once and never changes:

```ts
import { configs } from "@jondotsoy/configs";
import { sseSource } from "@jondotsoy/configs/sources/sse";

async function cleanupTempFiles() {
  // ...
}

const cfg = await configs.create(
  {
    service: configs.create({
      cleanupIntervalMs: { type: "number", summary: "cleanup interval", default: 60_000 },
    }),
  },
  { sources: [sseSource({ url: "https://config-service.internal/app/events" })] },
);

let timer: ReturnType<typeof setInterval> | undefined;

const unsubscribe = cfg.service.cleanupIntervalMs.subscribe((intervalMs) => {
  clearInterval(timer);
  timer = setInterval(cleanupTempFiles, intervalMs);
  return () => clearInterval(timer); // runs when `unsubscribe()` is called, not on the next change
});
```

`subscribe` fires immediately with the current value (starting the first timer) and again on every
subsequent change — `clearInterval(timer)` cancels the previous one before `setInterval` starts the
new one, so there's never more than one timer running for this field. The callback's returned
cleanup only fires once, when `unsubscribe()` itself is called, so it's the right place to stop the
last timer for good — it's not a substitute for the `clearInterval` at the top of the callback.

### ⚛️ `useConfig` — reading a field in React

`@jondotsoy/configs/react` exports a `useConfig(store)` hook that subscribes a component to any
field (or nested group) and re-renders it on every update. React is a peer dependency — the hook
only needs it if you actually import this subpath, so it's never pulled into apps that don't use
React:

```tsx
import { configs } from "@jondotsoy/configs";
import { useConfig } from "@jondotsoy/configs/react";

const cfg = configs.create({ bannerIsActive: { type: "boolean", default: false } });

function App() {
  const bannerIsActive = useConfig(cfg.bannerIsActive);

  return bannerIsActive ? <Banner /> : null;
}
```

### Closing a config tree

`configs.create(...)` results (and their nested groups) expose `close()`, which closes every
source backing them — for `sseSource`, this aborts the live connection instead of leaving
it open in the background:

```ts
import { configs } from "@jondotsoy/configs";
import { sseSource } from "@jondotsoy/configs/sources/sse";

const source = sseSource({ url: "https://config-service.internal/app/events" });
const serverConfigs = await configs.create({ port: { type: "number" } }, { sources: [source] });

await serverConfigs.close();
```

It also implements `Symbol.asyncDispose`, so `await using` closes it automatically at the end of
the scope — including when the scope throws:

```ts
import { configs } from "@jondotsoy/configs";
import { sseSource } from "@jondotsoy/configs/sources/sse";

async function run() {
  await using serverConfigs = await configs.create(
    { port: { type: "number" } },
    { sources: [sseSource({ url: "https://config-service.internal/app/events" })] },
  );

  console.log(serverConfigs.port.get());
  // closed automatically here, no explicit serverConfigs.close() needed
}
```
