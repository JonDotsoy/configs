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
