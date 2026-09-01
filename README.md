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
import { configs } from "@jondotsoy/configs";
import { envSource, mapKey } from "@jondotsoy/configs/sources/env";
import { fetchSource } from "@jondotsoy/configs/sources/fetch";

// SERVER_PORT=3000 SERVER_HOST=localhost → { server: { port: "3000", host: "localhost" } }
// GET https://example.com/features → { promoService: true } (polled every 30s)
const cfg = await configs.create({
  server: configs.create(
    {
      port: { type: "number", summary: "HTTP port", default: 3000 },
      host: { type: "string", summary: "bind host", default: "localhost" },
    },
    { sources: [envSource({ mapKey: mapKey.snakeCase() })] },
  ),
  features: configs.create(
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

### `sseSource` — live updates over Server-Sent Events

Connects to an SSE endpoint (`url`, `method`, `headers`). Every message tries to parse as JSON and,
if it's a plain object, is applied as a **patch** on top of what was already received — fields add
up and overwrite, the tree is never replaced wholesale:

```ts
import { sseSource } from "@jondotsoy/configs/sources/sse";

const source = sseSource<{ port?: number; host?: string }>({
  url: "https://config-service.internal/app/events",
});

// message: {"port":3000}       => Store<{ port: 3000 }>
// message: {"host":"10.0.0.1"} => Store<{ port: 3000, host: "10.0.0.1" }>
```

A message that isn't valid JSON, or doesn't parse to a plain object, is logged via
`console.error` and skipped — it never resets what was already received.

Opening the source waits for the first message (so the `Store` you get back already has data,
not `null`), then keeps the connection alive in the background, applying further messages as
patches until the resource closes the stream.

### `fileSource` — a local `.json` or `.env` file

Reads a config tree from `path`, parsed by its extension: `.json` or `.env` (matched by extension,
or by the bare `.env` filename itself — a `.env` file always parses to a flat string map, one
entry per `KEY=VALUE` line, blank lines and `#`-comments skipped). `watch` defaults to `true`: the
file is re-read and the store updated live on every change; `watch: false` reads it once. A
missing file, an unrecognized extension, or a parse failure (including on a later watched change)
is logged via `console.error` and leaves the store empty instead of throwing — a parse error on a
later change keeps the last good value instead.

```ts
import { fileSource } from "@jondotsoy/configs/sources/file";

const source = fileSource<{ port: number; host: string }>("./config.json");
// config.json: { "port": 3000, "host": "localhost" }
```

### `pullSource` — calling a function on an interval

Calls `pull` and publishes whatever it returns as the next snapshot — once immediately, then again
every `interval` milliseconds until the `Source` is closed. `pull` can be sync or async, so it's a
general-purpose escape hatch for any input that isn't already covered by a built-in source (a
database query, a cloud secrets manager, a gRPC call, ...). A `pull` failure is logged via
`console.error` and swallowed instead of thrown: on the first call this leaves the store empty
(same as `fetchSource`); on a later call it's skipped, keeping the last good value and the polling
running.

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
