# Examples

Runnable-shaped snippets for common ways to wire up `@jondotsoy/configs`.
Each one is self-contained: the source file(s), the config input(s) it
reads, and a short note on why it's put together that way.

- [Kubernetes: reload on ConfigMap change](./kubernetes.md) — `fileSource`
  watching a mounted `ConfigMap`, live-updated without a pod restart.
- [`.env` defaults plus a JSON overlay](./env-and-file.md) — a nested config
  tree where one branch reads `envSource` and the root reads `fileSource`.
- [React: polling a remote feature-flag endpoint](./react-fetch.md) —
  `fetchSource` with `pollingInterval`, read from a component via
  `useConfig`.
- [Verifying Google-signed JWTs against rotating keys](./jwt-auth.md) —
  `fetchSource` with `treePath` and `pollingInterval` to keep a JWKS in
  sync.

See also [`docs/getting-starter/features.md`](../getting-starter/features.md)
for per-runtime support notes.
