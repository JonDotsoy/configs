// Case: `@jondotsoy/configs/node`'s file() field decodes a source's raw
// value into a FileBlob, and a URL default is read from disk eagerly.
// node:fs-backed, so a browser bundle stubs it out (see manifest.ts's
// tolerateFailureEngines for this case) — run there anyway to document the
// breakage instead of skipping it.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, literalSource } from "@jondotsoy/configs";
import { FileBlob, file } from "@jondotsoy/configs/node";

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("ok - " + message);
}

/** `node:url`'s `pathToFileURL` isn't available under a browser bundle — a plain `file://` + absolute POSIX path stands in for it here. */
function toFileURL(path: string): URL {
  return new URL(`file://${path}`);
}

const source1 = literalSource({ key: "hello" });
const cfg1 = await create({ key: file() }, { sources: [source1] });
const blob1 = cfg1.key.get();
assert(blob1 instanceof FileBlob, "a source's text value resolves to a FileBlob");
assert((await blob1!.text()) === "hello", "FileBlob.text() decodes the text value");
assert(blob1!.location instanceof URL, "a source-derived FileBlob still has a .location");
assert((await readFile(blob1!.location!, "utf-8")) === "hello", ".location points at a temp file holding the decoded content");
await source1.close();

const source1c = literalSource({ key: "hello" });
const cfg1c = await create(
  { key: file({ required: true }) },
  { sources: [source1c] },
);
assert((await cfg1c.key.get().text()) === "hello", "required: true still resolves normally when a source has the value");
await source1c.close();

const cfg1b = await create(
  { key: file({ default: "foo=tar&biz=lol", format: "text" }) },
  {},
);
const formData = await cfg1b.key.get().formData();
assert(formData instanceof FormData, "FileBlob.formData() returns a FormData");
assert(formData.get("foo") === "tar", "FileBlob.formData() parses application/x-www-form-urlencoded pairs");
assert(formData.get("biz") === "lol", "FileBlob.formData() parses every pair");

const dir = await mkdtemp(join(tmpdir(), "configs-node-file-case-"));
try {
  const path = join(dir, "cert.pem");
  await writeFile(path, "-----BEGIN CERTIFICATE-----");

  const cfg2 = await create(
    { key: file({ default: toFileURL(path) }) },
    {},
  );
  const blob2 = cfg2.key.get();
  assert(blob2 instanceof FileBlob, "a URL default loads a FileBlob from disk");
  assert((await blob2!.text()) === "-----BEGIN CERTIFICATE-----", "the loaded FileBlob has the file's content");
  assert(blob2!.type === "application/x-pem-file", "FileBlob.type infers a mimetype from the location's extension");

  const cfg3 = await create(
    { key: file({ default: toFileURL(join(dir, "missing.pem")) }) },
    {},
  );
  assert(cfg3.key.get() === null, "a missing URL default resolves the field to null");
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("ALL_CHECKS_PASSED");
