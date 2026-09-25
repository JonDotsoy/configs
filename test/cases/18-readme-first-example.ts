// Case: the README's first example — envSource() with explicit `key`s for a
// flat server group, a file() field reading a TLS cert from disk, and a
// nested group with its own fetchSource (against a `data:` URL). The file()
// field is node:fs-backed, so a browser bundle stubs it out — run there
// anyway to document the breakage instead of skipping it (see manifest.ts's
// tolerateFailureEngines for this case).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, numeric, string, boolean, envSource, fetchSource } from "@jondotsoy/configs";
import { file, FileBlob } from "@jondotsoy/configs/node";

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

/** `node:url`'s `pathToFileURL` isn't available under a browser bundle — a plain `file://` + absolute POSIX path stands in for it here. */
function toFileURL(path: string): URL {
  return new URL(`file://${path}`);
}

const body = JSON.stringify({ experimental: { home: { promotionalDialog: true } } });
const featuresUrl = `data:application/json,${encodeURIComponent(body)}`;

const dir = await mkdtemp(join(tmpdir(), "configs-readme-case-"));
try {
  const certPath = join(dir, "server.pem");
  await writeFile(certPath, "-----BEGIN CERTIFICATE-----");

  const cfg = await create(
    {
      server: {
        host: string({ summary: "bind host", default: "localhost", key: "HOST" }),
        port: numeric({ summary: "HTTP port", default: 3000, key: "PORT" }),
        tlsCert: file({ summary: "TLS certificate", default: toFileURL(certPath) }),
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
  assert(cfg.server.tlsCert.get() instanceof FileBlob, "tlsCert's URL default loads a FileBlob from disk");
  assert((await cfg.server.tlsCert.get()!.text()) === "-----BEGIN CERTIFICATE-----", "the loaded FileBlob has the file's content");

  await cfg.close();
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("ALL_CHECKS_PASSED");
