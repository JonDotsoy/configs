import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Descriptor, shapeFailure, type WithDefault } from "./config-descriptor.js";
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

/**
 * Writes `payload` out to a fresh file under the OS temp directory and returns its `file:` `URL`
 * — `FileBlob.location` for any value that didn't already come from a real file on disk (a
 * source's raw value, or a string `default`). Each call gets its own temp directory (via
 * `mkdtempSync`), so concurrent/repeated resolutions never collide; nothing on this package's side
 * cleans these up afterwards.
 */
function writeTempFileSync(payload: Uint8Array): URL {
  const dir = mkdtempSync(join(tmpdir(), "configs-file-"));
  const path = join(dir, "file");
  writeFileSync(path, payload);
  return toFileURL(path);
}

/** Decodes `value` (per `decodeValue`) and writes it out to a temp file, returning a `FileBlob` whose `.location` points at that copy. */
function blobFromText(value: string, format: FileValueFormat | undefined): FileBlob {
  const payload = decodeValue(value, format);
  return new FileBlob(payload, writeTempFileSync(payload));
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

/** Resolves `default` (per `file()`'s options) into a `FileBlob`, or `undefined` — either because there's no default, or a `URL` default's file doesn't exist. */
function resolveDefault(defaultValue: string | URL | undefined, format: FileValueFormat | undefined): FileBlob | undefined {
  if (defaultValue === undefined) return undefined;
  if (defaultValue instanceof URL) {
    const payload = readLocationSync(defaultValue);
    return payload === undefined ? undefined : new FileBlob(payload, defaultValue);
  }
  return blobFromText(defaultValue, format);
}

/**
 * `file()`'s own not-yet-resolved type: same as `WithDefault<O, FileBlob>`, except `required:
 * true` also narrows it to `FileBlob` (never `null`) — same effect a real `default` has
 * elsewhere, applied here from `required` instead since a `file()` field almost always wants
 * "always present" enforced by `required`, not by a fallback value. Same caveat as `default`
 * everywhere else in this package: this is a type-level promise, not a runtime guarantee — a
 * `required` field with nothing from any source still resolves to `null` at runtime, it just
 * isn't supposed to happen.
 */
type FileFieldValue<O extends FileFieldOptions> = O extends { required: true } ? FileBlob : WithDefault<O, FileBlob>;

/**
 * `file()`'s own `start` — decodes a raw string value (as base64 or text, per `format` or
 * inferred — see `FileFieldOptions.format`) into a `FileBlob`; an already-`FileBlob` value (its
 * own resolved `default`) passes through as-is. A decoding failure — a non-string/non-`FileBlob`
 * raw value, or `atob()` rejecting invalid base64 — is logged and resolves to `null` unless
 * `required` escalates it into a thrown `ConfigError`, same "log unless required" rule every
 * schema-based field (`shape()`, `file()`) follows (see `shapeFailure`).
 */
function fileStart(options: Pick<FileFieldOptions, "required" | "format">): (raw: unknown, path: string[]) => FileBlob {
  return (raw, path) => {
    if (raw instanceof FileBlob) return raw;
    if (typeof raw !== "string") {
      return shapeFailure(
        options.required,
        new ConfigError(`Value at "${path.join(".")}" is not a file: expected a string, got ${JSON.stringify(raw)}`),
      ) as FileBlob;
    }
    const [ok, err, result] = tSync(() => blobFromText(raw, options.format));
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
 */
export function file<const O extends FileFieldOptions = {}>(options?: O): Descriptor<FileFieldValue<O>, FileBlob> {
  const opts = options ?? ({} as O);

  const runtimeOptions: Omit<FileFieldOptions, "default"> & { default?: FileBlob } = {
    summary: opts.summary,
    required: opts.required,
    freeze: opts.freeze,
    key: opts.key,
    format: opts.format,
  };

  const resolvedDefault = resolveDefault(opts.default, opts.format);
  if (resolvedDefault !== undefined) runtimeOptions.default = resolvedDefault;

  const parse = fileStart(runtimeOptions);
  const defaultValue = runtimeOptions.default !== undefined ? runtimeOptions.default : (null as unknown as FileBlob);

  return new Descriptor<FileBlob, FileBlob>({
    type: "file",
    options: runtimeOptions,
    start(control) {
      control.rawStore.subscribe((raw) => {
        control.set(raw === undefined || raw === null ? defaultValue : parse(raw, control.path));
      });
    },
  }) as Descriptor<FileFieldValue<O>, FileBlob>;
}
