// Case: the README's first example — envSource() with explicit `key`s for a
// flat server group, alongside a nested group with its own fetchSource
// (against a `data:` URL, so this runs unmodified in a browser too).
import { create, numeric, string, boolean, envSource, fetchSource } from "@jondotsoy/configs";

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

const body = JSON.stringify({ experimental: { home: { promotionalDialog: true } } });
const featuresUrl = `data:application/json,${encodeURIComponent(body)}`;

const cfg = await create(
  {
    server: {
      host: string({ summary: "bind host", default: "localhost", key: "HOST" }),
      port: numeric({ summary: "HTTP port", default: 3000, key: "PORT" }),
    },
    features: create(
      {
        experimental: {
          home: {
            promotionalDialog: boolean({ summary: "show the promotional dialog", default: false }),
          },
        },
      },
      { sources: [fetchSource({ url: featuresUrl })] },
    ),
  },
  { sources: [envSource({ env: { HOST: "example.com", PORT: "8080" } })] },
);

assert(cfg.server.host.get() === "example.com", "HOST resolves to server.host via an explicit key");
assert(cfg.server.port.get() === 8080, "PORT resolves to server.port via an explicit key");
assert(
  cfg.features.experimental.home.promotionalDialog.get() === true,
  "features nests its own fetchSource under experimental.home.promotionalDialog",
);

await cfg.close();
console.log("ALL_CHECKS_PASSED");
