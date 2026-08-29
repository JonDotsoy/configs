import { httpFetch, type HttpFetchRequest } from "../utils/http-fetch.js";
import { Source } from "./source.js";

export interface FetchSourceOptions<T = unknown> {
  url: string | URL;
  method?: string;
  headers?: RequestInit["headers"];
  /** Attempts to download the data before giving up. Defaults to 1 (no retry). */
  attempts?: number;
  /** Turns the fetched `Response` into `T`. Defaults to `(res) => res.json()`. */
  bodyParser?: (response: Response) => Promise<T>;
  /**
   * Decides whether a response's status code counts as accepted. Defaults
   * to 2xx: `(statusCode) => statusCode >= 200 && statusCode < 300`.
   */
  acceptStatus?: (statusCode: number) => boolean;
  /**
   * Milliseconds between fetches. Defaults to `false`: polling is off, so `fetchSource` fetches
   * `url` exactly once and closes. Set it to a number to keep fetching `url` on that interval
   * (each round retried up to `attempts` times) until the `Source` is closed.
   */
  pollingInterval?: number | false;
}

/** Runs one `httpFetch` round, logging and swallowing any failure into `undefined`. */
async function fetchRound<T>(req: HttpFetchRequest<T>): Promise<{ data: T } | undefined> {
  try {
    const result = await httpFetch<T>(req);
    return { data: result.body };
  } catch (error) {
    console.error(`fetchSource: failed to fetch "${req.url}"`, error);
    return undefined;
  }
}

/**
 * A `Source` that fetches a snapshot from `url`. The response body is turned into `T` by
 * `bodyParser` (defaulting to `(res) => res.json()`), so non-JSON responses are supported by
 * passing a custom parser. HTTP request/retry mechanics are delegated to the internal
 * `httpFetch` helper, which throws when the download never succeeds (network error or a
 * status rejected by `acceptStatus`, after exhausting `attempts`) or when `bodyParser` throws.
 * `fetchSource` catches that, logs a `console.error`, and leaves the store empty (`null`)
 * instead of throwing.
 *
 * By default (`pollingInterval: false`) it fetches `url` exactly once and closes. Set
 * `pollingInterval` to a number of milliseconds to keep fetching on that interval instead — each
 * round retried up to `attempts` times, updating the store on every successful fetch, until the
 * `Source` is closed. A failed round after the first one is logged and skipped, without closing
 * the source or stopping the polling.
 */
export function fetchSource<T = unknown>(options: FetchSourceOptions<T>): Source<T> {
  const { url, method = "GET", headers, attempts = 1, bodyParser, acceptStatus, pollingInterval = false } = options;
  const req = { url, method, headers, attempts, bodyParser, acceptStatus };
  let timer: ReturnType<typeof setTimeout> | undefined;

  return new Source<T>({
    async start(control) {
      const first = await fetchRound<T>(req);
      if (!first) {
        control.close();
        return;
      }

      control.set(first.data);

      if (pollingInterval === false) {
        control.close();
        return;
      }

      const scheduleNext = () => {
        timer = setTimeout(async () => {
          const result = await fetchRound<T>(req);
          if (result) control.set(result.data);
          scheduleNext();
        }, pollingInterval);
      };
      scheduleNext();
    },
    close() {
      clearTimeout(timer);
    },
  });
}
