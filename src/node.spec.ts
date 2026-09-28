import { describe, expect, expectTypeOf, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { create } from "./configs";
import { Store } from "./utils/store";
import { literalSource } from "./sources/literal";
import { FileBlob, file } from "./node";

describe("file()", () => {
  describe("format inference from a source value", () => {
    test("decodes a base64 value", async () => {
      const base64 = Buffer.from("hello").toString("base64");
      const cfg = await create(
        { key: file() },
        { sources: [literalSource({ key: base64 })] },
      );

      const blob = cfg.key.get();
      expect(blob).toBeInstanceOf(FileBlob);
      expect(await blob!.bytes()).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
      expect(await blob!.text()).toBe("hello");
    });

    test("decodes a plain text value", async () => {
      const cfg = await create(
        { key: file() },
        { sources: [literalSource({ key: "hello" })] },
      );

      const blob = cfg.key.get();
      expect(await blob!.bytes()).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
      expect(await blob!.text()).toBe("hello");
    });

    test("format: \"text\" forces text decoding even for a base64-looking value", async () => {
      const base64 = Buffer.from("hello").toString("base64");
      const cfg = await create(
        { key: file({ format: "text" }) },
        { sources: [literalSource({ key: base64 })] },
      );

      expect(await cfg.key.get()!.text()).toBe(base64);
    });

    test("format: \"base64\" forces base64 decoding", async () => {
      const base64 = Buffer.from("hello").toString("base64");
      const cfg = await create(
        { key: file({ format: "base64" }) },
        { sources: [literalSource({ key: base64 })] },
      );

      expect(await cfg.key.get()!.text()).toBe("hello");
    });
  });

  describe("default", () => {
    test("no value anywhere: .get() returns null", async () => {
      const cfg = await create({ key: file() }, { sources: [] });

      expect(cfg.key.get()).toBeNull();
    });

    test("a text default decodes into a FileBlob", async () => {
      const cfg = await create({ key: file({ default: "hello" }) }, { sources: [] });

      const blob = cfg.key.get();
      expect(blob).toBeInstanceOf(FileBlob);
      expect(await blob.text()).toBe("hello");
      expect(await blob.bytes()).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
    });

    test("a base64 default decodes into a FileBlob", async () => {
      const base64 = Buffer.from("hello").toString("base64");
      const cfg = await create({ key: file({ default: base64 }) }, { sources: [] });

      const blob = cfg.key.get();
      expect(await blob.text()).toBe("hello");
    });

    describe("a URL default", () => {
      let dir: string;

      test("an existing file is loaded into a FileBlob", async () => {
        dir = await mkdtemp(join(tmpdir(), "configs-file-field-"));
        try {
          const path = join(dir, "cert.pem");
          await Bun.write(path, "-----BEGIN CERTIFICATE-----");

          const cfg = await create(
            { key: file({ default: pathToFileURL(path) }) },
            { sources: [] },
          );

          const blob = cfg.key.get();
          expect(blob).toBeInstanceOf(FileBlob);
          expect(await blob.text()).toBe("-----BEGIN CERTIFICATE-----");
          expect(blob.location?.toString()).toBe(pathToFileURL(path).toString());
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });

      test("a missing file resolves the field to null", async () => {
        dir = await mkdtemp(join(tmpdir(), "configs-file-field-"));
        try {
          const path = join(dir, "missing.pem");

          const cfg = await create(
            { key: file({ default: pathToFileURL(path) }) },
            { sources: [] },
          );

          expect(cfg.key.get()).toBeNull();
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    });
  });

  describe("FileBlob", () => {
    test(".json() parses the content as JSON", async () => {
      const cfg = await create(
        { key: file({ default: JSON.stringify({ a: 1 }), format: "text" }) },
        { sources: [] },
      );

      expect(await cfg.key.get().json()).toEqual({ a: 1 });
    });

    test(".formData() parses the content as application/x-www-form-urlencoded", async () => {
      const cfg = await create(
        { key: file({ default: "foo=tar&biz=lol", format: "text" }) },
        { sources: [] },
      );

      const formData = await cfg.key.get().formData();
      expect(formData).toBeInstanceOf(FormData);
      expect(formData.get("foo")).toBe("tar");
      expect(formData.get("biz")).toBe("lol");
    });

    test(".text() returns the decoded string", async () => {
      const cfg = await create({ key: file({ default: "hello", format: "text" }) }, { sources: [] });

      expect(await cfg.key.get().text()).toBe("hello");
    });

    test(".size returns the content's byte length", async () => {
      const cfg = await create({ key: file({ default: "hello", format: "text" }) }, { sources: [] });

      expect(cfg.key.get().size).toBe(5);
    });

    test(".type infers a mimetype from the location's filename", async () => {
      const dir = await mkdtemp(join(tmpdir(), "configs-file-field-"));
      try {
        const path = join(dir, "config.json");
        await Bun.write(path, "{}");

        const cfg = await create({ key: file({ default: pathToFileURL(path) }) }, { sources: [] });

        expect(cfg.key.get().type).toBe("application/json");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test(".type is application/octet-stream without a location", async () => {
      const cfg = await create({ key: file({ default: "hello", format: "text" }) }, { sources: [] });

      expect(cfg.key.get().type).toBe("application/octet-stream");
    });

    test(".bytes() returns a Uint8Array of the content", async () => {
      const cfg = await create({ key: file({ default: "hello", format: "text" }) }, { sources: [] });

      expect(await cfg.key.get().bytes()).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
    });

    test(".arrayBuffer() returns the content as an ArrayBuffer", async () => {
      const cfg = await create({ key: file({ default: "hello", format: "text" }) }, { sources: [] });

      const buffer = await cfg.key.get().arrayBuffer();
      expect(buffer).toBeInstanceOf(ArrayBuffer);
      expect(new Uint8Array(buffer)).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
    });

    test(".stream() returns a ReadableStream that yields the content", async () => {
      const cfg = await create({ key: file({ default: "hello", format: "text" }) }, { sources: [] });

      const reader = cfg.key.get().stream().getReader();
      const { value } = await reader.read();
      expect(value).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
    });

    test(".exists() resolves true for a loaded file", async () => {
      const cfg = await create({ key: file({ default: "hello", format: "text" }) }, { sources: [] });

      expect(await cfg.key.get().exists()).toBe(true);
    });

    test(".location points at a temp file when the value came from a source, not a real file", async () => {
      const cfg = await create({ key: file() }, { sources: [literalSource({ key: "hello" })] });

      const blob = cfg.key.get()!;
      expect(blob.location).toBeInstanceOf(URL);
      expect(blob.location!.protocol).toBe("file:");
      expect(await readFile(blob.location!, "utf-8")).toBe("hello");
    });

    test(".location points at a temp file for a string default too", async () => {
      const cfg = await create({ key: file({ default: "hello", format: "text" }) }, { sources: [] });

      const blob = cfg.key.get();
      expect(blob.location).toBeInstanceOf(URL);
      expect(await readFile(blob.location!, "utf-8")).toBe("hello");
    });

    test.skipIf(process.platform === "win32")(
      "the temp file/directory are locked down to owner-only, read-only access",
      async () => {
        const cfg = await create({ key: file() }, { sources: [literalSource({ key: "s3cr3t" })] });

        const blob = cfg.key.get()!;
        const filePath = new URL(blob.location!);
        const fileStat = await stat(filePath);
        const dirStat = await stat(join(filePath.pathname, ".."));

        expect(fileStat.mode & 0o777).toBe(0o400);
        expect(dirStat.mode & 0o777).toBe(0o700);
      },
    );

    test(".location is the same URL given as a URL default", async () => {
      const dir = await mkdtemp(join(tmpdir(), "configs-file-field-"));
      try {
        const path = join(dir, "cert.pem");
        await Bun.write(path, "-----BEGIN CERTIFICATE-----");

        const cfg = await create({ key: file({ default: pathToFileURL(path) }) }, { sources: [] });

        expect(cfg.key.get().location?.toString()).toBe(pathToFileURL(path).toString());
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test("close() removes the temp file and its temp directory from disk", async () => {
      const cfg = await create({ key: file() }, { sources: [literalSource({ key: "s3cr3t" })] });

      const filePath = new URL(cfg.key.get()!.location!);
      const dirPath = join(filePath.pathname, "..");
      expect(await stat(filePath).then(() => true, () => false)).toBe(true);

      await cfg.close();

      expect(await stat(filePath).then(() => true, () => false)).toBe(false);
      expect(await stat(dirPath).then(() => true, () => false)).toBe(false);
    });

    test("close() also removes a string default's own temp file", async () => {
      const cfg = await create({ key: file({ default: "hello", format: "text" }) }, { sources: [] });

      const filePath = new URL(cfg.key.get()!.location!);
      await cfg.close();

      expect(await stat(filePath).then(() => true, () => false)).toBe(false);
    });

    test("close() leaves a URL default's own file on disk untouched — file() never created it", async () => {
      const dir = await mkdtemp(join(tmpdir(), "configs-file-field-"));
      try {
        const path = join(dir, "cert.pem");
        await Bun.write(path, "-----BEGIN CERTIFICATE-----");

        const cfg = await create({ key: file({ default: pathToFileURL(path) }) }, { sources: [] });
        await cfg.close();

        expect(await stat(path).then(() => true, () => false)).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("required", () => {
    test("required: true narrows .get()'s type to FileBlob, never null", async () => {
      const cfg = await create(
        { key: file({ required: true }) },
        { sources: [literalSource({ key: "hello" })] },
      );

      expectTypeOf(cfg.key).toEqualTypeOf<Store<FileBlob>>();
      expect(await cfg.key.get().text()).toBe("hello");
    });

    test("without required, .get()'s type stays FileBlob | null", async () => {
      const cfg = await create({ key: file() }, { sources: [] });

      expectTypeOf(cfg.key).toEqualTypeOf<Store<FileBlob | null>>();
    });
  });

  test("wires into create() as a nested field", async () => {
    const cfg = await create(
      { server: { ssl: { key: file() } } },
      { sources: [literalSource({ server: { ssl: { key: "hello" } } })] },
    );

    expect(await cfg.server.ssl.key.get()!.text()).toBe("hello");
  });
});
