# React: polling a remote feature-flag endpoint

`fetchSource` with `pollingInterval` keeps refetching a URL on an interval
and republishes the store on every successful round. `useConfig` (from
`@jondotsoy/configs/react`) subscribes a component to that store via
`useSyncExternalStore`, so the component re-renders whenever the flag
changes — no manual polling or state wiring in the component itself.

`fetchSource` only depends on the global `fetch()`, so it's safe to use in
the browser — see
[`docs/getting-starter/features.md`](../getting-starter/features.md#browser-support).

## `App.tsx`

```tsx
import { create, boolean } from "@jondotsoy/configs";
import { fetchSource } from "@jondotsoy/configs/sources/fetch";
import { useConfig } from "@jondotsoy/configs/react";
import { Temporal } from "temporal-polyfill";

const cfg = await create(
  {
    features: {
      promoService: boolean({ summary: "enable the promo service", default: false }),
    },
  },
  {
    sources: [
      fetchSource({
        url: "http://my-resource/features.json",
        pollingInterval: Temporal.Duration.from({ minutes: 1 }).total("milliseconds"),
      }),
    ],
  },
);

export default function App() {
  const promoService = useConfig(cfg.features.promoService);

  return <p>Promo service is {promoService ? "on" : "off"}</p>;
}
```

## `GET http://my-resource/features.json`

```
HTTP/1.1 200 OK
Content-Type: application/json

{
  "features": {
    "promoService": true
  }
}
```

`create(...)` is awaited once, at module scope — the initial fetch
resolves before the first render, so `App` never has to render a loading
state for the config itself. Every fetch after that (once a minute here)
just republishes `cfg.features.promoService` in place.

## See also

- [Verifying Google-signed JWTs against rotating keys](./jwt-auth.md) for
  another `fetchSource` + `pollingInterval` example, this time with a
  `shape()` field validated by a zod schema instead of a scalar type.
