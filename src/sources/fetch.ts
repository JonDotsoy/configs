import { Source } from "./source.js";

export interface FetchSourceOptions {
  url: string | URL;
  method?: string;
  headers?: RequestInit["headers"];
  /** Attempts to download the data before giving up. Defaults to 1 (no retry). */
  attempts?: number;
  /**
   * Milliseconds between fetches. Defaults to `false`: polling is off, so `fetchSource` fetches
   * `url` exactly once and closes. Set it to a number to keep fetching `url` on that interval
   * (each round retried up to `attempts` times) until the `Source` is closed.
   */
  pollingInterval?: number | false;
}

async function download(url: string | URL, init: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`fetchSource: received ${response.status} ${response.statusText} from "${url}"`);
  }
  return response;
}

/** Downloads and parses `url` as JSON, retrying up to `attempts` times. Logs and returns `undefined` on failure. */
async function fetchOnce<T>(
  url: string | URL,
  init: RequestInit,
  attempts: number,
): Promise<{ data: T } | undefined> {
  let response: Response | undefined;
  let lastError: unknown;

  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    try {
      response = await download(url, init);
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!response) {
    console.error(`fetchSource: failed to fetch "${url}" after ${attempts} attempt(s)`, lastError);
    return undefined;
  }

  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();

  try {
    return { data: JSON.parse(text) as T };
  } catch (error) {
    console.error(
      `fetchSource: response body from "${url}" is not valid JSON (content-type: "${contentType}")`,
      error,
    );
    return undefined;
  }
}

/**
 * A `Source` that fetches a JSON snapshot from `url`. Only JSON is supported: the response is
 * parsed as JSON regardless of what `Content-Type` reports (a non-JSON content type is a fallback
 * attempt, not a hard failure). If the download never succeeds, or the body isn't valid JSON, this
 * logs a `console.error` and leaves the store empty (`null`) instead of throwing.
 *
 * By default (`pollingInterval: false`) it fetches `url` exactly once and closes. Set
 * `pollingInterval` to a number of milliseconds to keep fetching on that interval instead — each
 * round retried up to `attempts` times, updating the store on every successful fetch, until the
 * `Source` is closed. A failed round after the first one is logged and skipped, without closing
 * the source or stopping the polling.
 */
export function fetchSource<T = unknown>(options: FetchSourceOptions): Source<T> {
  const { url, method = "GET", headers, attempts = 1, pollingInterval = false } = options;
  const init: RequestInit = { method, headers };
  let timer: ReturnType<typeof setTimeout> | undefined;

  return new Source<T>({
    async start(control) {
      const first = await fetchOnce<T>(url, init, attempts);
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
          const result = await fetchOnce<T>(url, init, attempts);
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
