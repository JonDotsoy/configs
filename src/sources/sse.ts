import {
  applyCredentials,
  defaultAcceptStatus,
  downloadWithRetry,
  type HttpFetchCredentials,
} from "../utils/http-fetch.js";
import { Source } from "./source.js";

export type { HttpFetchCredentials };

export interface SseSourceOptions<T = unknown> {
  url: string | URL;
  method?: string;
  headers?: RequestInit["headers"];
  /** Request body, passed through to `fetch` as-is (e.g. a JSON string, `FormData`, `Blob`). */
  body?: RequestInit["body"];
  /**
   * Aborts the connection (and stops retrying it) when the signal fires. Independent of the
   * `Source`'s own `close()`, which also aborts the connection.
   */
  signal?: AbortSignal;
  /** Passed through to `fetch` as-is. See `RequestInit["mode"]`. */
  mode?: RequestInit["mode"];
  /** Passed through to `fetch` as-is. See `RequestInit["cache"]`. */
  cache?: RequestInit["cache"];
  /** Passed through to `fetch` as-is. See `RequestInit["redirect"]`. */
  redirect?: RequestInit["redirect"];
  /**
   * Sets the `Authorization` header for the request. `{ basic: { username, password } }` sends
   * `Basic <base64>`; `{ bearer: { token } }` sends `Bearer <token>`. See `HttpFetchCredentials`.
   */
  credentials?: HttpFetchCredentials;
  /** Attempts to establish the connection before giving up. Defaults to 1 (no retry). */
  attempts?: number;
  /**
   * Decides whether a response's status code counts as accepted. Defaults
   * to 2xx: `(statusCode) => statusCode >= 200 && statusCode < 300`.
   */
  acceptStatus?: (statusCode: number) => boolean;
  /**
   * Combines each parsed message with the config tree accumulated so far, overriding the default
   * shallow patch-merge (new fields added, existing ones overwritten, everything else kept).
   * Receives the parsed message as `incoming` and the previously published tree as `previous`
   * (`null` before the first message). Defaults to the shallow patch-merge described above — a
   * custom `reduce` replaces it entirely, so it must do its own merging if that's still wanted.
   * Takes precedence over `overwrite` when both are set.
   */
  reduce?: (incoming: T, previous: T | null) => T;
  /**
   * Replaces the accumulated tree wholesale with each parsed message instead of shallow
   * patch-merging it. Ignored when `reduce` is set. Defaults to `false`.
   */
  overwrite?: boolean;
}

function isPatch(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extracts the `data:` payload from one `\n\n`-delimited SSE event, joining multi-line data per spec. */
function extractData(rawEvent: string): string | null {
  const dataLines = rawEvent
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).replace(/^ /, ""));

  return dataLines.length > 0 ? dataLines.join("\n") : null;
}

async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (rawEvent: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        onEvent(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * A `Source` that connects to a Server-Sent Events endpoint. Every message tries to parse as
 * JSON; a successful parse of a plain object is published via `control.set`, which — through this
 * source's `reduce` — is applied as a shallow patch onto the config tree accumulated so far (new
 * fields are added, existing ones overwritten, everything else kept) — e.g. `{"port":3000}` then
 * `{"host":"10.0.0.1"}` end up as `{ port: 3000, host: "10.0.0.1" }`.
 * A message that isn't valid JSON, or doesn't parse to a plain object, is logged via
 * `console.error` and skipped, without disturbing the accumulated state or the connection.
 *
 * `start()` only resolves once the first message has been applied (or the connection closed
 * without ever receiving one) — so `open()` always hands back a `Store` with data already in it,
 * not one waiting on a race. The connection then stays open in the background, applying further
 * messages as patches, until the resource closes the stream — or `close()` is called on the
 * returned `Source` (or via a config tree's own `close()`), which aborts the connection.
 *
 * Beyond `url`/`method`/`headers`, it accepts the same request-shaping options as `fetchSource`:
 * `body`, `signal`, `mode`, `cache`, `redirect`, `credentials`, `attempts` (retries only the
 * initial connection — once the stream is open, a dropped connection closes the source rather
 * than reconnecting), and `acceptStatus`. Set `overwrite: true` to replace the tree wholesale on
 * every message instead of merging. `reduce` overrides the default patch-merge (or `overwrite`)
 * behavior entirely.
 */
export function sseSource<T = unknown>(options: SseSourceOptions<T>): Source<T> {
  const {
    url,
    method = "GET",
    headers,
    body,
    signal: externalSignal,
    mode,
    cache,
    redirect,
    credentials,
    attempts = 1,
    acceptStatus = defaultAcceptStatus,
    reduce,
    overwrite = false,
  } = options;
  const defaultReduce = (patch: T, previous: T | null): T =>
    overwrite
      ? patch
      : ({
          ...((previous as Record<string, unknown> | null) ?? {}),
          ...(patch as Record<string, unknown>),
        } as T);
  const abortController = new AbortController();
  const signal = externalSignal ? AbortSignal.any([externalSignal, abortController.signal]) : abortController.signal;

  return new Source<T>({
    async start(control) {
      let response: Response;
      try {
        response = await downloadWithRetry(
          url,
          { method, headers: applyCredentials(headers, credentials), body, signal, mode, cache, redirect },
          attempts,
          acceptStatus,
        );
      } catch (error) {
        if (!abortController.signal.aborted) {
          console.error(`sseSource: failed to connect to "${url}"`, error);
        }
        control.close();
        return;
      }

      if (!response.body) {
        console.error(`sseSource: response from "${url}" has no body`);
        control.close();
        return;
      }

      await new Promise<void>((resolveFirstMessage) => {
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          resolveFirstMessage();
        };

        readEvents(response.body!, (rawEvent) => {
          const raw = extractData(rawEvent);
          if (raw === null || raw.trim() === "") return;

          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch (error) {
            console.error(`sseSource: message from "${url}" is not valid JSON`, error);
            return;
          }

          if (!isPatch(parsed)) {
            console.error(`sseSource: message from "${url}" did not parse to a JSON object`, parsed);
            return;
          }

          control.set(parsed as T);
          settle();
        })
          .catch((error) => {
            if (!abortController.signal.aborted) {
              console.error(`sseSource: connection to "${url}" ended with an error`, error);
            }
          })
          .finally(() => {
            control.close();
            settle();
          });
      });
    },
    reduce: reduce ?? defaultReduce,
    close() {
      abortController.abort();
    },
  });
}
