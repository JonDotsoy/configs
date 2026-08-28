import { Source } from "./source";

export interface FetchSourceOptions {
  url: string | URL;
  method?: string;
  headers?: Bun.HeadersInit;
  /** Attempts to download the data before giving up. Defaults to 1 (no retry). */
  attempts?: number;
}

async function download(url: string | URL, init: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`fetchSource: received ${response.status} ${response.statusText} from "${url}"`);
  }
  return response;
}

/**
 * A `Source` that fetches a JSON snapshot from `url`. Only JSON is supported: the response is
 * parsed as JSON regardless of what `Content-Type` reports (a non-JSON content type is a fallback
 * attempt, not a hard failure). If the download never succeeds, or the body isn't valid JSON, this
 * logs a `console.error` and leaves the store empty (`null`) instead of throwing.
 */
export function fetchSource<T = unknown>(options: FetchSourceOptions): Source<T> {
  const { url, method = "GET", headers, attempts = 1 } = options;

  return new Source<T>({
    async start(control) {
      let response: Response | undefined;
      let lastError: unknown;

      for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
        try {
          response = await download(url, { method, headers });
          break;
        } catch (error) {
          lastError = error;
        }
      }

      if (!response) {
        console.error(`fetchSource: failed to fetch "${url}" after ${attempts} attempt(s)`, lastError);
        control.close();
        return;
      }

      const contentType = response.headers.get("content-type") ?? "";
      const text = await response.text();

      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch (error) {
        console.error(
          `fetchSource: response body from "${url}" is not valid JSON (content-type: "${contentType}")`,
          error,
        );
        control.close();
        return;
      }

      control.set(data as T);
      control.close();
    },
  });
}
