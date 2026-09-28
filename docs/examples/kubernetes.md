# Kubernetes: reload on ConfigMap change

Mount a `ConfigMap` as a file and read it with `fileSource`. `fileSource`
watches the file by default (`watch: true`), so when `kubelet` re-syncs a
mounted `ConfigMap` after a `kubectl apply`, the store republishes and every
subscriber sees the new value — no pod restart needed.

`fileSource` uses `node:fs`, so it only runs in a Node.js-compatible
runtime (Node, Bun) — see
[`docs/getting-starter/features.md`](../getting-starter/features.md#isomorphism).

## `server.ts`

```ts
import { create, boolean } from "hotconfigs";
import { fileSource } from "hotconfigs/sources/file";

const configs = await create(
  {
    features: {
      promoService: boolean({ summary: "enable the promo service", default: false }),
    },
  },
  // fileSource re-reads the file every time kubelet syncs the mounted ConfigMap
  { sources: [fileSource("/etc/config/configs.json")] },
);

configs.features.promoService.subscribe((enabled) => {
  console.log(`promo service ${enabled ? "enabled" : "disabled"}`);
});
```

## `configmap.yml`

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  configs.json: |
    {
      "features": {
        "promoService": true
      }
    }
```

## `deployment.yml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  template:
    spec:
      containers:
        - name: app
          image: registry.example.com/app:latest
          volumeMounts:
            - name: config
              mountPath: /etc/config
      volumes:
        - name: config
          configMap:
            name: app-config
```

Updating the value is then a normal GitOps/`kubectl` change:

```sh
kubectl create configmap app-config \
  --from-literal=configs.json='{"features":{"promoService":false}}' \
  --dry-run=client -o yaml | kubectl apply -f -
```

Kubernetes propagates the new file to the mounted volume within its usual
sync period (kubelet's `--sync-frequency`, plus the kubelet's ConfigMap
cache TTL — up to ~1 minute by default), `fileSource`'s `fs.watch` picks up
the change, and `configs.features.promoService.subscribe(...)` fires again with
the new value.

## See also

- [`.env` defaults plus a JSON overlay](./env-and-file.md) for combining
  `fileSource` with `envSource` in one config tree.
