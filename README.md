# @jondotsoy/configs

A tool for all your configurations.

## Features

- **Reactive configs** — every field is a live `Store`; subscribe to it and get notified whenever an upstream datasource changes.
- **Lightweight** — no dependencies, just a thin layer over plain objects and stores.
- **Typed with TS check** — schemas are statically checked, so `cfg.port.get()` is inferred as `number | null` (or `number` when a `default` is set), not `any`.

## Example

```ts
import { configs, DataSource } from "@jondotsoy/configs";

const envSource = new DataSource<{ port: number; host: string }>({
  async start(control) {
    control.set({
      port: Number(process.env.PORT),
      host: process.env.HOST!,
    });
    control.close();
  },
});

const serverConfigs = await configs.create(
  {
    port: { type: "number", summary: "HTTP port", default: 3000 },
    host: { type: "string", summary: "bind host", default: "localhost" },
    tls: configs.create({
      key: { type: "string", summary: "TLS key path" },
      cert: { type: "string", summary: "TLS cert path" },
    }),
  },
  { datasources: [envSource] },
);

// React to changes
serverConfigs.port.subscribe((port) => {
  console.log(`listening on port ${port}`);
});

console.log(serverConfigs.port.get());
// 3000
```

## Install

```sh
npm install @jondotsoy/configs
```
