// Case: `@jondotsoy/configs/node`'s file() field decodes a source's raw
// value into a FileBlob, and a URL default is read from disk eagerly.
// node:fs-backed, so a browser bundle stubs it out (see manifest.ts's
// tolerateFailureEngines for this case) — run there anyway to document the
// breakage instead of skipping it.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configs, literalSource } from "@jondotsoy/configs";
import { FileBlob, file } from "@jondotsoy/configs/node";

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

/** `node:url`'s `pathToFileURL` isn't available under a browser bundle — a plain `file://` + absolute POSIX path stands in for it here. */
function toFileURL(path: string): URL {
  return new URL(`file://${path}`);
}

const cfg1 = await configs.create({ key: file() }, { sources: [literalSource({ key: "hello" })] });
const blob1 = cfg1.key.get();
assert(blob1 instanceof FileBlob, "a source's text value resolves to a FileBlob");
assert((await blob1!.text()) === "hello", "FileBlob.text() decodes the text value");
await cfg1.close();

const dir = await mkdtemp(join(tmpdir(), "configs-node-file-case-"));
try {
  const path = join(dir, "cert.pem");
  await writeFile(path, "-----BEGIN CERTIFICATE-----");

  const cfg2 = await configs.create(
    { key: file({ default: toFileURL(path) }) },
    { sources: [] },
  );
  const blob2 = cfg2.key.get();
  assert(blob2 instanceof FileBlob, "a URL default loads a FileBlob from disk");
  assert((await blob2!.text()) === "-----BEGIN CERTIFICATE-----", "the loaded FileBlob has the file's content");
  assert(blob2!.type === "application/x-pem-file", "FileBlob.type infers a mimetype from the location's extension");
  await cfg2.close();

  const cfg3 = await configs.create(
    { key: file({ default: toFileURL(join(dir, "missing.pem")) }) },
    { sources: [] },
  );
  assert(cfg3.key.get() === null, "a missing URL default resolves the field to null");
  await cfg3.close();
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("ALL_CHECKS_PASSED");
