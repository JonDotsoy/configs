# @jondotsoy/configs

A tool for all your configurations.

## Features

- **Reactive configs** — every field is a live `Store`; subscribe to it and get notified whenever an upstream datasource changes.
- **Lightweight** — no dependencies, just a thin layer over plain objects and stores.
- **Typed with TS check** — schemas are statically checked, so `cfg.port.get()` is inferred as `number | null` (or `number` when a `default` is set), not `any`.

## Example

```ts
import { configs, envDataSource, envKeyToPath } from "@jondotsoy/configs";

// SERVER_PORT=3000 SERVER_HOST=localhost → { server: { port: "3000", host: "localhost" } }
const envSource = envDataSource({ mapKey: envKeyToPath });

const serverConfigs = await configs.create(
  {
    server: configs.create({
      port: { type: "number", summary: "HTTP port", default: 3000 },
      host: { type: "string", summary: "bind host", default: "localhost" },
    }),
    tls: configs.create({
      key: { type: "string", summary: "TLS key path" },
      cert: { type: "string", summary: "TLS cert path" },
    }),
  },
  { datasources: [envSource] },
);

// React to changes
serverConfigs.server.port.subscribe((port) => {
  console.log(`listening on port ${port}`);
});

console.log(serverConfigs.server.port.get());
// 3000
```

## Install

```sh
npm install @jondotsoy/configs
```

## Guide

### `DataSource` — building a custom datasource

The building block behind `envDataSource`, `fetchDataSource`, and `sseDataSource`. It takes an
object with `start(control)` and an optional `close()`, mirroring `ReadableStream`'s
`UnderlyingSource`: `start` runs once and pushes snapshots via `control.set(value)`, while `close`
— called from within `start` via `control.close()`, or from the outside via the `DataSource`'s own
`close()` — is where you release whatever `start` set up, like a timer or an in-flight request.

```ts
import { DataSource } from "@jondotsoy/configs";

function pollingDataSource(url: string, intervalMs: number): DataSource<{ port: number }> {
  let timer: ReturnType<typeof setInterval>;

  return new DataSource({
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

### `envDataSource` — environment variables

Reads `process.env` (or any object you pass as `env`) into the config tree. `mapKey` decides how
each key maps to a path; the default is the identity mapping, `"FOO_TAR" => ["FOO_TAR"]`. The
`envKeyToPath` helper turns a `SCREAMING_SNAKE_CASE` key into a lowercase nested path instead:
`"FOO_TAR" => ["foo", "tar"]`.

```ts
import { envDataSource, envKeyToPath } from "@jondotsoy/configs";

// SERVER_PORT=3000 SERVER_HOST=localhost → { server: { port: "3000", host: "localhost" } }
const source = envDataSource({ mapKey: envKeyToPath });
```

### `fetchDataSource` — a JSON endpoint over HTTP

Fetches a JSON snapshot from `url` (with `method` and `headers`, if needed). Only JSON is
supported — a non-JSON `Content-Type` still gets a fallback parse attempt. `attempts` retries the
download on a network error or a non-`ok` response (default `1`, no retry). If the download never
succeeds, or the body isn't valid JSON, it logs a `console.error` and leaves the store empty
instead of throwing.

```ts
import { fetchDataSource } from "@jondotsoy/configs";

const source = fetchDataSource<{ port: number }>({
  url: "https://config-service.internal/app",
  method: "GET",
  headers: { authorization: `Bearer ${process.env.CONFIG_TOKEN}` },
  attempts: 3,
});
```

### `sseDataSource` — live updates over Server-Sent Events

Connects to an SSE endpoint (`url`, `method`, `headers`). Every message tries to parse as JSON and,
if it's a plain object, is applied as a **patch** on top of what was already received — fields add
up and overwrite, the tree is never replaced wholesale:

```ts
import { sseDataSource } from "@jondotsoy/configs";

const source = sseDataSource<{ port?: number; host?: string }>({
  url: "https://config-service.internal/app/events",
});

// message: {"port":3000}       => Store<{ port: 3000 }>
// message: {"host":"10.0.0.1"} => Store<{ port: 3000, host: "10.0.0.1" }>
```

A message that isn't valid JSON, or doesn't parse to a plain object, is logged via
`console.error` and skipped — it never resets what was already received.

Opening the datasource waits for the first message (so the `Store` you get back already has data,
not `null`), then keeps the connection alive in the background, applying further messages as
patches until the resource closes the stream.

### Reacting to changes — restarting a periodic task

Because every field is a live `Store`, `.subscribe()` is the hook point for keeping something
else in sync with the config — for example, restarting a `setInterval` job whenever its period
changes. This only really happens at runtime with a live datasource like `sseDataSource`; an
`envDataSource` resolves once and never changes:

```ts
import { configs, sseDataSource } from "@jondotsoy/configs";

async function cleanupTempFiles() {
  // ...
}

const cfg = await configs.create(
  {
    service: configs.create({
      cleanupIntervalMs: { type: "number", summary: "cleanup interval", default: 60_000 },
    }),
  },
  { datasources: [sseDataSource({ url: "https://config-service.internal/app/events" })] },
);

let timer: ReturnType<typeof setInterval> | undefined;

cfg.service.cleanupIntervalMs.subscribe((intervalMs) => {
  clearInterval(timer);
  timer = setInterval(cleanupTempFiles, intervalMs);
});
```

`subscribe` fires immediately with the current value (starting the first timer) and again on every
subsequent change — `clearInterval(timer)` cancels the previous one before `setInterval` starts the
new one, so there's never more than one timer running for this field.

### Closing a config tree

`configs.create(...)` results (and their nested groups) expose `close()`, which closes every
datasource backing them — for `sseDataSource`, this aborts the live connection instead of leaving
it open in the background:

```ts
import { configs, sseDataSource } from "@jondotsoy/configs";

const source = sseDataSource({ url: "https://config-service.internal/app/events" });
const serverConfigs = await configs.create({ port: { type: "number" } }, { datasources: [source] });

await serverConfigs.close();
```

It also implements `Symbol.asyncDispose`, so `await using` closes it automatically at the end of
the scope — including when the scope throws:

```ts
import { configs, sseDataSource } from "@jondotsoy/configs";

async function run() {
  await using serverConfigs = await configs.create(
    { port: { type: "number" } },
    { datasources: [sseDataSource({ url: "https://config-service.internal/app/events" })] },
  );

  console.log(serverConfigs.port.get());
  // closed automatically here, no explicit serverConfigs.close() needed
}
```
