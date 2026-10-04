import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeValue, Descriptor, shapeFailure, subscribeParsed, type Settled, type WithDefault } from "./config-descriptor.js";
import { ConfigError } from "./errors.js";
import { tSync } from "./utils/t.js";

/**
 * Builds a `file:` `URL` from an absolute POSIX-style path, e.g. `/tmp/-Fasg42/file` — standing in
 * for `node:url`'s `pathToFileURL` (not used here on purpose: a bundle targeting `browser`, like
 * `bun run test:cases`'s browser engine produces from a package consuming `./node`, doesn't ship a
 * `pathToFileURL` export in its `node:url` polyfill, and unlike a *runtime* gap elsewhere in this
 * module that a browser bundle only trips over when actually called, an unresolved *import* like
 * that one fails the bundle itself).
 */
function toFileURL(path: string): URL {
  return new URL(`file://${path}`);
}

/** Extensions mapped to a MIME type for `FileBlob.type`, keyed lowercase including the leading dot. */
const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  ".json": "application/json",
  ".txt": "text/plain",
  ".env": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".pem": "application/x-pem-file",
  ".crt": "application/x-x509-ca-cert",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};

/** The MIME type for `location`, inferred from its pathname's extension. `application/octet-stream` for none/unknown. */
function mimeTypeFromLocation(location: URL | undefined): string {
  if (!location) return "application/octet-stream";
  const dot = location.pathname.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  return MIME_TYPES_BY_EXTENSION[location.pathname.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

/**
 * A file's loaded content plus a bit of metadata, returned by `file()` fields. Every accessor is
 * cheap: the raw bytes are already fully loaded in memory by the time a `FileBlob` exists (see
 * `file()`), so nothing here does its own I/O.
 */
export class FileBlob {
  readonly #payload: Uint8Array;
  readonly #location?: URL;

  constructor(payload: Uint8Array, location?: URL) {
    this.#payload = payload;
    this.#location = location;
  }

  /**
   * Where this file's content lives on disk, e.g. `file:///tmp/-Fasg42/file.txt`. For a `file:`
   * `URL` default, this is that same `URL`; for any other value (a source's raw value, or a
   * string `default`), the decoded content is written out to a fresh temp file (see `file()`) and
   * this points at that copy — always set, never `undefined`.
   */
  get location(): URL | undefined {
    return this.#location;
  }

  /** Size of the loaded content, in bytes. */
  get size(): number {
    return this.#payload.byteLength;
  }

  /** MIME type inferred from `location`'s filename, e.g. `application/json`. `application/octet-stream` without a `location` or a recognized extension. */
  get type(): string {
    return mimeTypeFromLocation(this.#location);
  }

  /** Whether the file's content is present — always `true` for a resolved `FileBlob`, since it's already fully loaded. */
  async exists(): Promise<boolean> {
    return true;
  }

  /** The content decoded as UTF-8 text. */
  async text(): Promise<string> {
    return new TextDecoder().decode(this.#payload);
  }

  /** The content decoded as UTF-8 text and parsed with `JSON.parse`. */
  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }

  /** The content as an `ArrayBuffer`. */
  async arrayBuffer(): Promise<ArrayBuffer> {
    const { buffer, byteOffset, byteLength } = this.#payload;
    return buffer.slice(byteOffset, byteOffset + byteLength) as ArrayBuffer;
  }

  /** The content as a `Uint8Array` (a fresh copy, safe to mutate). */
  async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    return this.#payload.slice() as Uint8Array<ArrayBuffer>;
  }

  /**
   * The content decoded as UTF-8 text and parsed as `application/x-www-form-urlencoded`
   * (`foo=bar&biz=lol`) into a `FormData` — handy for a `file()` field whose value is a query
   * string rather than JSON.
   */
  async formData(): Promise<FormData> {
    const params = new URLSearchParams(await this.text());
    const form = new FormData();
    for (const [key, value] of params) form.append(key, value);
    return form;
  }

  /** The content as a single-chunk `ReadableStream`. */
  stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    const bytes = this.#payload.slice() as Uint8Array<ArrayBuffer>;
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }
}

/** `file()`'s value format: `"text"` encodes the string as-is (UTF-8); `"base64"` decodes it first. Defaults to inferring from the value's shape (see `looksLikeBase64`). */
export type FileValueFormat = "text" | "base64";

export interface FileFieldOptions {
  summary?: string;
  required?: boolean;
  /** Freezes the field at its first resolved value: later source updates no longer reach `.get()`. */
  freeze?: boolean;
  key?: string | string[];
  /**
   * Picks how to decode a source's raw string value (and a string `default`) instead of
   * inferring it — `"text"` encodes it as UTF-8 as-is, `"base64"` decodes it first. Defaults to
   * inferring per-value: a string that looks like base64 (see `looksLikeBase64`) is decoded as
   * base64, everything else is treated as text.
   */
  format?: FileValueFormat;
  /**
   * Fallback used when no source has a value for this field. A `string` is decoded the same way
   * as a source's raw value (`format`, or inferred). A `file:` `URL` is read from local disk
   * eagerly, right when `file()` is called — if that file doesn't exist, no default is set at
   * all, and the field resolves to `null`, same as any other field with no default and nothing
   * published by a source.
   */
  default?: string | URL;
  /**
   * Permission bits (e.g. `0o400`, `0o600`) applied to every temp file this field writes out to
   * disk (a source's raw value, or a string `default`) — `chmod`'d right after each one is written,
   * regardless of the process umask. Defaults to `0o400` (owner read-only, no write, no execute, no
   * access for group/other). Never applied to a `file:` `URL` default: that's a real file `file()`
   * didn't create, and this option only controls files `file()` itself writes.
   */
  mode?: number;
  /**
   * When `true`, this field's own `close()` leaves the temp file(s)/directory(ies) it created (its
   * resolved default's, and one per raw value a live source published over the field's lifetime) on
   * disk instead of deleting them — e.g. when something else still needs to read the file's
   * `.location` after the config tree itself has been closed. Defaults to `false` (`close()` deletes
   * them). Never affects a `file:` `URL` default, which `file()` never created and so never deletes
   * either way.
   */
  avoidCleanup?: boolean;
  /**
   * Overrides where this field's temp file/directory is created, instead of the OS temp directory
   * (`node:os`'s `tmpdir()`) — mainly a debugging knob, for pointing the written file somewhere
   * easy to find and inspect by hand (a fixed local folder, say) instead of an ephemeral OS temp
   * path. The directory must already exist; `file()` still creates its own fresh subdirectory
   * inside it via `mkdtempSync`, same as it does under `tmpdir()`, so concurrent/repeated
   * resolutions still never collide.
   */
  tempDir?: string;
}

/** Whether `value` looks like base64: only base64-alphabet characters (plus up to two trailing `=`), and a length that's a multiple of 4. */
function looksLikeBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decodes `value` per `format`, or — without one — by inferring base64 vs. text via `looksLikeBase64`. */
function decodeValue(value: string, format: FileValueFormat | undefined): Uint8Array {
  const resolvedFormat = format ?? (looksLikeBase64(value) ? "base64" : "text");
  return resolvedFormat === "base64" ? decodeBase64(value) : new TextEncoder().encode(value);
}

/** `FileFieldOptions.mode`'s default: owner read-only, no write, no execute, no access for group/other. */
const DEFAULT_FILE_MODE = 0o400;

/**
 * The write-time knobs a single `file()` call shares across every temp file it ever writes (its
 * resolved default's, and one per raw value a live source publishes) — bundled into one object
 * instead of threading `mode`/`baseDir`/`trackDir` as separate parameters through
 * `writeTempFileSync` → `blobFromText` → `resolveDefault`/`fileStart`.
 */
interface TempFileContext {
  /** `FileFieldOptions.mode`, defaulted. */
  mode: number;
  /** `FileFieldOptions.tempDir`, defaulted to `tmpdir()` — the directory `mkdtempSync` creates its fresh subdirectory under. */
  baseDir: string;
  /** Records a freshly created temp directory so `file()`'s own `close()` can remove it again (a no-op when `avoidCleanup` is set). */
  trackDir(dir: string): void;
}

/**
 * Writes `payload` out to a fresh file under `ctx.baseDir` and returns its `file:` `URL` —
 * `FileBlob.location` for any value that didn't already come from a real file on disk (a source's
 * raw value, or a string `default`). Each call gets its own temp directory (via `mkdtempSync`), so
 * concurrent/repeated resolutions never collide. `ctx.trackDir` is handed the fresh directory so the
 * caller (`file()`) can remove it again on `close()` (see `file()`'s own doc) — this function itself
 * never deletes anything.
 *
 * A field's decoded value can be a secret (a `file()`'s whole point is often to hand a private
 * key/credential to something that only accepts a file path), so both the directory and the file
 * are locked down to the owning user only by default: the directory is `chmod`'d `0o700` right
 * after creation — `mkdtempSync` alone only gets there if the process umask happens to allow it, so
 * this doesn't rely on that — and the file itself is written `ctx.mode` (`FileFieldOptions.mode`,
 * defaulting to `0o400`). The explicit `chmodSync` after each write matters as much as the `mode`
 * passed to `writeFileSync` itself: both are subject to the process umask, which can mask off bits
 * `mode` asks for, so the follow-up `chmodSync` (unaffected by umask) is what actually guarantees
 * the final permissions.
 */
function writeTempFileSync(payload: Uint8Array, ctx: TempFileContext): URL {
  const dir = mkdtempSync(join(ctx.baseDir, "configs-file-"));
  ctx.trackDir(dir);
  chmodSync(dir, 0o700);
  const path = join(dir, "file");
  writeFileSync(path, payload, { mode: ctx.mode });
  chmodSync(path, ctx.mode);
  return toFileURL(path);
}

/** Decodes `value` (per `decodeValue`) and writes it out to a temp file, returning a `FileBlob` whose `.location` points at that copy — `ctx` is forwarded to `writeTempFileSync` as-is. */
function blobFromText(value: string, format: FileValueFormat | undefined, ctx: TempFileContext): FileBlob {
  const payload = decodeValue(value, format);
  return new FileBlob(payload, writeTempFileSync(payload, ctx));
}

/**
 * Builds a `FileBlob` from a raw `file://` URL string: the file is read from that existing location
 * and used as-is (`.location` is the URL itself, never copied to a temp file nor tracked for cleanup,
 * same as a `URL` default). Throws if the URL is invalid or the file can't be read.
 */
function blobFromLocation(raw: string): FileBlob {
  const location = new URL(raw);
  return new FileBlob(new Uint8Array(readFileSync(location)), location);
}

/** Reads `location` from disk synchronously; `undefined` (not thrown) when the file doesn't exist. */
function readLocationSync(location: URL): Uint8Array | undefined {
  try {
    return new Uint8Array(readFileSync(location));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Resolves `default` (per `file()`'s options) into a `FileBlob`, or `undefined` — either because
 * there's no default, or a `URL` default's file doesn't exist. A `URL` default is read from its
 * existing location as-is (never tracked for cleanup, and `ctx.mode`/`ctx.baseDir` never apply to
 * it — `file()` didn't create that file, so it has no business changing its permissions, location,
 * or deleting it); a string default is written to a fresh temp file via `blobFromText`, tracked
 * through `ctx.trackDir` same as any source-provided value.
 */
function resolveDefault(defaultValue: string | URL | undefined, format: FileValueFormat | undefined, ctx: TempFileContext): FileBlob | undefined {
  if (defaultValue === undefined) return undefined;
  if (defaultValue instanceof URL) {
    const payload = readLocationSync(defaultValue);
    return payload === undefined ? undefined : new FileBlob(payload, defaultValue);
  }
  return blobFromText(defaultValue, format, ctx);
}

/**
 * `file()`'s own `start` — decodes a raw string value (as base64 or text, per `format` or
 * inferred — see `FileFieldOptions.format`) into a `FileBlob`; an already-`FileBlob` value (its
 * own resolved `default`) passes through as-is. A decoding failure — a non-string/non-`FileBlob`
 * raw value, or `atob()` rejecting invalid base64 — is logged and resolves to `null` unless
 * `required` escalates it into a thrown `ConfigError`, same "log unless required" rule every
 * schema-based field (`shape()`, `file()`) follows (see `shapeFailure`).
 */
function fileStart(
  options: Pick<FileFieldOptions, "required" | "format">,
  ctx: TempFileContext,
): (raw: unknown, path: string[]) => FileBlob {
  return (raw, path) => {
    if (raw instanceof FileBlob) return raw;
    if (typeof raw !== "string") {
      return shapeFailure(
        options.required,
        new ConfigError(`Value at "${path.join(".")}" is not a file: expected a string, got ${describeValue(raw, path)}`),
      ) as FileBlob;
    }
    const [ok, err, result] = tSync(() => (raw.startsWith("file://") ? blobFromLocation(raw) : blobFromText(raw, options.format, ctx)));
    if (ok) return result;
    const message = err instanceof Error ? err.message : String(err);
    return shapeFailure(
      options.required,
      new ConfigError(`Value at "${path.join(".")}" could not be decoded as a file: ${message}`),
    ) as FileBlob;
  };
}

/**
 * Builds a field descriptor that loads its value as a file: a source's raw string value is
 * decoded (as base64 or text, per `format` or inferred — see `FileFieldOptions.format`) into a
 * `FileBlob`. `default` accepts the same string form, or a `file:` `URL` read from local disk
 * eagerly (see `FileFieldOptions.default`).
 *
 * `.location` is always set: a `file:` `URL` default is used as-is, and every other value (a
 * source's raw value, or a string `default`) is written out to a fresh temp file whose `file:`
 * `URL` becomes `.location`.
 *
 * Every temp directory this descriptor ever creates (its resolved default's, and one per raw value
 * a live source publishes over the field's lifetime — `subscribeParsed` re-runs `parse` on each
 * update) is tracked and, unless `avoidCleanup: true` (see `FileFieldOptions.avoidCleanup`), removed
 * recursively by this descriptor's own `close()` — `create()`'s own `close()` (`./config-node.js`)
 * calls it once per field. A `file:` `URL` default is never tracked, and neither `FileFieldOptions.mode`
 * nor `FileFieldOptions.tempDir` are ever applied to it either: it points at a file this descriptor
 * didn't create, so it isn't this descriptor's to touch, relocate, or delete.
 *
 * Returned as `Descriptor<Pending, Awaited>` where both are computed from `O` up front and passed
 * in explicitly, same as every built-in builder in `./config-descriptor.js`:
 * `Descriptor<FileBlob | null, FileBlob | null>` with neither `default` nor `required`,
 * `Descriptor<FileBlob, FileBlob>` with a `default`, or `Descriptor<FileBlob | null, FileBlob>`
 * with `required: true` alone (see `WithDefault`/`Settled`).
 */
export function file<const O extends FileFieldOptions = {}>(options?: O): Descriptor<WithDefault<O, FileBlob>, Settled<O, FileBlob>> {
  const opts = options ?? ({} as O);
  const avoidCleanup = opts.avoidCleanup ?? false;
  const tempDirs = new Set<string>();
  const ctx: TempFileContext = {
    mode: opts.mode ?? DEFAULT_FILE_MODE,
    baseDir: opts.tempDir ?? tmpdir(),
    trackDir: avoidCleanup ? () => {} : (dir) => tempDirs.add(dir),
  };

  const runtimeOptions: Omit<FileFieldOptions, "default"> & { default?: FileBlob } = {
    summary: opts.summary,
    required: opts.required,
    freeze: opts.freeze,
    key: opts.key,
    format: opts.format,
    mode: opts.mode,
    avoidCleanup: opts.avoidCleanup,
    tempDir: opts.tempDir,
  };

  const resolvedDefault = resolveDefault(opts.default, opts.format, ctx);
  if (resolvedDefault !== undefined) runtimeOptions.default = resolvedDefault;

  const parse = fileStart(runtimeOptions, ctx);
  const defaultValue = runtimeOptions.default !== undefined ? runtimeOptions.default : (null as unknown as FileBlob);

  return new Descriptor<FileBlob, FileBlob>({
    type: "file",
    options: runtimeOptions,
    start(control) {
      subscribeParsed(control, defaultValue, parse);
    },
    async close() {
      await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
    },
  }) as Descriptor<WithDefault<O, FileBlob>, Settled<O, FileBlob>>;
}
