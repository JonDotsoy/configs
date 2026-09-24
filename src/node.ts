import { readFileSync } from "node:fs";
import { ConfigDescriptor, type Parseable, type ShapeFieldOptions } from "./config.types.js";
import { ConfigError } from "./errors.js";

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

  /** Where this file was loaded from on disk, e.g. `file:///tmp/-Fasg42/file.txt` — `undefined` when it came from an inline (non-`URL`) value instead. */
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
  readonly?: boolean;
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
  return new FileBlob(decodeValue(defaultValue, format));
}

/**
 * Builds a field descriptor that loads its value as a file: a source's raw string value is
 * decoded (as base64 or text, per `format` or inferred — see `FileFieldOptions.format`) into a
 * `FileBlob`. `default` accepts the same string form, or a `file:` `URL` read from local disk
 * eagerly (see `FileFieldOptions.default`).
 */
export function file<const O extends FileFieldOptions = {}>(options?: O): ConfigDescriptor<FileBlob, O> {
  const opts = options ?? ({} as O);
  const schema: Parseable<FileBlob> = {
    parse(raw: unknown): FileBlob {
      if (raw instanceof FileBlob) return raw;
      if (typeof raw !== "string") {
        throw new ConfigError(`file(): expected a string value, got ${JSON.stringify(raw)}`);
      }
      return new FileBlob(decodeValue(raw, opts.format));
    },
  };

  const runtimeOptions: ShapeFieldOptions & { schema: Parseable<FileBlob>; default?: FileBlob } = {
    schema,
    summary: opts.summary,
    required: opts.required,
    readonly: opts.readonly,
    key: opts.key,
  };

  const resolvedDefault = resolveDefault(opts.default, opts.format);
  if (resolvedDefault !== undefined) runtimeOptions.default = resolvedDefault;

  return new ConfigDescriptor("shape", runtimeOptions) as unknown as ConfigDescriptor<FileBlob, O>;
}
