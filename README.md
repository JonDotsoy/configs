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

## Guide

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

## Install

```sh
npm install @jondotsoy/configs
```
