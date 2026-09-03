# Verifying Google-signed JWTs against rotating keys

Google rotates its OAuth2 signing keys every few hours. `fetchSource` with
`pollingInterval` keeps a local copy of the JWKS in sync, so a running
process always verifies against current keys without a redeploy.

The JWKS response is an array of key objects, not a scalar
`string`/`number`/`boolean`. `configs.create()`'s `type: "shape"` field
covers exactly that: `schema` takes anything shaped like a validation
library's schema (`{ parse(value): T }` — zod, valibot, superstruct, ...)
and the field's value comes out typed as whatever that schema parses to.
The response is already shaped as `{ keys: [...] }`, so the field is
just named `keys` to match — no `treePath` needed.

## `auth.ts`

```ts
import { create } from "@jondotsoy/configs";
import { fetchSource } from "@jondotsoy/configs/sources/fetch";
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { Temporal } from "temporal-polyfill";
import { z } from "zod";

const googleJwkSchema = z.object({
  kty: z.string(),
  e: z.string(),
  use: z.string(),
  kid: z.string(),
  alg: z.string(),
  n: z.string(),
});
const googleJwksSchema = z.array(googleJwkSchema);

const cfg = await create(
  {
    keys: { type: "shape", schema: googleJwksSchema, required: true },
  },
  {
    sources: [
      fetchSource({
        url: "https://www.googleapis.com/oauth2/v3/certs",
        // Google rotates these keys every few hours — polling keeps them current.
        pollingInterval: Temporal.Duration.from({ hours: 1 }).total("milliseconds"),
      }),
    ],
  },
);

export async function verifyGoogleIdToken(idToken: string) {
  const { kid, alg } = decodeProtectedHeader(idToken);
  const jwk = cfg.keys.get()?.find((key) => key.kid === kid);
  if (!jwk) throw new Error(`no matching Google signing key for kid "${kid}"`);
  const key = await importJWK(jwk, alg);

  const { payload } = await jwtVerify(idToken, key, {
    issuer: "https://accounts.google.com",
    audience: process.env.GOOGLE_CLIENT_ID,
  });

  return payload;
}
```

## `GET https://www.googleapis.com/oauth2/v3/certs`

```
HTTP/1.1 200 OK
Content-Type: application/json; charset=UTF-8
Cache-Control: public, max-age=21600, must-revalidate, no-transform

{
  "keys": [
    {
      "kty": "RSA",
      "e": "AQAB",
      "use": "sig",
      "kid": "f0f9f4a3c2b1d0e5a6b7c8d9e0f1a2b3c4d5e6f7",
      "alg": "RS256",
      "n": "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXOshU..."
    },
    {
      "kty": "RSA",
      "e": "AQAB",
      "use": "sig",
      "kid": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      "alg": "RS256",
      "n": "yGkzX3vRJvQvR5xz4C1QYr8bK2dLxN6mFwZtJq..."
    }
  ]
}
```

`await create(...)` waits for the first fetch round before `cfg` is used.
`required: true` on `keys` doesn't stop a bad response from resolving —
it changes what happens when code actually reads the field: a response
`googleJwksSchema` can't parse resolves `keys` to `null` and only logs a
`console.error`, but `required: true` makes `cfg.keys.get()` itself throw
a `ConfigError` in that case, so `verifyGoogleIdToken` never silently
treats a broken JWKS as "no keys". `cfg.keys.get()` comes back typed as
`z.infer<typeof googleJwksSchema>`, inferred straight from the schema.
Every subsequent poll (hourly here) re-validates the response and
republishes `keys` in place.

## See also

- [React: polling a remote feature-flag endpoint](./react-fetch.md) for
  another `fetchSource` + `pollingInterval` example, this time with a
  plain `boolean` field instead of a `"shape"` schema.
