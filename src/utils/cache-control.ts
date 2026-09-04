/** Directives parsed out of a `Cache-Control` header relevant to polling cadence. */
export interface CacheControlDirectives {
  /** `max-age=<seconds>`, in seconds. */
  maxAge?: number;
  /** `no-store` was present. */
  noStore?: boolean;
  /** `no-cache` was present. */
  noCache?: boolean;
}

/**
 * Parses a `Cache-Control` header value into `CacheControlDirectives`. Only the directives
 * relevant to scheduling the next poll (`max-age`, `no-store`, `no-cache`) are recognized; any
 * other directive (`private`, `must-revalidate`, ...) is ignored. `header` being `null`/empty
 * (no header present) returns an empty object.
 */
export function parseCacheControl(header: string | null | undefined): CacheControlDirectives {
  const directives: CacheControlDirectives = {};
  if (!header) return directives;

  for (const part of header.split(",")) {
    const [rawKey, rawValue] = part.split("=");
    const key = rawKey?.trim().toLowerCase();
    if (!key) continue;

    if (key === "no-store") directives.noStore = true;
    else if (key === "no-cache") directives.noCache = true;
    else if (key === "max-age") {
      const value = Number(rawValue?.trim());
      if (Number.isFinite(value) && value >= 0) directives.maxAge = value;
    }
  }

  return directives;
}
