# `.env` defaults plus a JSON overlay

A config tree can nest another config tree, and each branch can read from
its own set of sources. Here `server` reads from process env vars
(`envSource`), while the root — and therefore `features` — reads from a
JSON file (`fileSource`). Both are live: change either input and the
matching store republishes.

## `configs.ts`

```ts
import { create } from "@jondotsoy/configs";
import { envSource, mapKey } from "@jondotsoy/configs/sources/env";
import { fileSource } from "@jondotsoy/configs/sources/file";

export default await create(
  {
    server: create(
      {
        port: { type: "number", summary: "HTTP port", default: 3000 },
        host: { type: "string", summary: "bind host", default: "localhost" },
      },
      { sources: [envSource({ mapKey: mapKey.camelCase() })] },
    ),
    features: create({
      promoService: {
        type: "boolean",
        summary: "enable the promo service",
        default: false,
      },
    }),
  },
  { sources: [fileSource("./configs.json")] },
);
```

## `.env`

```sh
PORT=3000
HOST=localhost
```

## `configs.json`

```json
{
  "features": {
    "promoService": false
  }
}
```

`mapKey.camelCase()` maps `PORT` → `port` and `HOST` → `host`, matching the
`server` schema's field names. Since `envSource` is only wired to the
`server` branch, `features` is untouched by env vars — it only ever comes
from `configs.json`.

## See also

- [Kubernetes: reload on ConfigMap change](./kubernetes.md) for using
  `fileSource` against a mounted `ConfigMap` instead of a local file.
