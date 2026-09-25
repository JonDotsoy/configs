// Case: the README's first example — envSource() with explicit `key`s for a
// flat server group, a nested server.tls group with file() fields reading a
// cert and key from disk, a nested features group with its own fetchSource
// (against a `data:` URL), and a nested database group with its own
// pullSource standing in for a secrets manager SDK call. file() is
// node:fs-backed, so a browser bundle stubs it out — run there anyway to
// document the breakage instead of skipping it (see manifest.ts's
// tolerateFailureEngines for this case).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, numeric, string, boolean, envSource, fetchSource, pullSource } from "@jondotsoy/configs";
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

/** Stands in for a secrets manager SDK call (e.g. AWS Secrets Manager's GetSecretValueCommand) that rotates the returned password on every pull. */
let secretPulls = 0;
async function getDatabaseSecret() {
  secretPulls++;
  return { host: "db.internal", port: 5432, user: "app", password: `rotated-${secretPulls}` };
}

const dir = await mkdtemp(join(tmpdir(), "configs-readme-case-"));
try {
  const certPath = join(dir, "server.pem");
  const keyPath = join(dir, "server-key.pem");
  await writeFile(certPath, "-----BEGIN CERTIFICATE-----");
  await writeFile(keyPath, "-----BEGIN PRIVATE KEY-----");

  const cfg = await create(
    {
      server: {
        host: string({ summary: "bind host", default: "localhost", key: "HOST", freeze: true }),
        port: numeric({ summary: "HTTP port", default: 3000, key: "PORT", freeze: true }),
        tls: {
          cert: file({ summary: "TLS certificate", default: toFileURL(certPath) }),
          key: file({ summary: "TLS private key", default: toFileURL(keyPath) }),
        },
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
      database: create(
        {
          host: string({ summary: "db host" }),
          port: numeric({ summary: "db port", default: 5432 }),
          user: string({ summary: "db user" }),
          password: string({ summary: "db password" }),
        },
        { sources: [pullSource({ pull: getDatabaseSecret, interval: 10 })] },
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
  assert(cfg.server.tls.cert.get() instanceof FileBlob, "server.tls.cert's URL default loads a FileBlob from disk");
  assert((await cfg.server.tls.cert.get()!.text()) === "-----BEGIN CERTIFICATE-----", "the loaded cert FileBlob has the file's content");
  assert(cfg.server.tls.key.get() instanceof FileBlob, "server.tls.key's URL default loads a FileBlob from disk");
  assert((await cfg.server.tls.key.get()!.text()) === "-----BEGIN PRIVATE KEY-----", "the loaded key FileBlob has the file's content");

  assert(cfg.database.host.get() === "db.internal", "database's pullSource resolves host from the first pull");
  assert(cfg.database.password.get() === "rotated-1", "database's pullSource resolves password from the first pull");

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert(
    cfg.database.password.get() !== "rotated-1",
    "a later pullSource round rotates the password, and .get() reflects it",
  );

  await cfg.close();
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("ALL_CHECKS_PASSED");
