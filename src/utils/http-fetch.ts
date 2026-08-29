export interface HttpFetchRequest<T = unknown> {
  url: string | URL;
  method?: string;
  headers?: RequestInit["headers"];
  /** Attempts to download the data before giving up. Defaults to 1 (no retry). */
  attempts?: number;
  /** Turns the fetched `Response` into `T`. Defaults to `(res) => res.json()`. */
  bodyParser?: (response: Response) => Promise<T>;
  /**
   * Decides whether a response's status code counts as accepted. A rejected
   * status stops retrying immediately (it's a definitive answer from the
   * server, not a transient failure). Defaults to 2xx:
   * `(statusCode) => statusCode >= 200 && statusCode < 300`.
   */
  acceptStatus?: (statusCode: number) => boolean;
}

export interface HttpFetchResponse<T> {
  statusCode: number;
  headers: Headers;
  body: T;
}

const defaultAcceptStatus = (statusCode: number) => statusCode >= 200 && statusCode < 300;
const defaultBodyParser = <T>(response: Response) => response.json() as Promise<T>;

/** Thrown by `download` when a response's status is rejected by `acceptStatus`. Not retried. */
class UnacceptedStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnacceptedStatusError";
  }
}

/** Thrown by `downloadWithRetry` when every attempt fails with a network error. */
class AttemptsExhaustedError extends Error {
  constructor(attempts: number, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`httpFetch: failed after ${attempts} attempt(s): ${causeMessage}`, { cause });
    this.name = "AttemptsExhaustedError";
  }
}

async function download(
  url: string | URL,
  init: RequestInit,
  acceptStatus: (statusCode: number) => boolean,
): Promise<Response> {
  const response = await fetch(url, init);
  if (!acceptStatus(response.status)) {
    throw new UnacceptedStatusError(
      `httpFetch: received unexpected status ${response.status} ${response.statusText} from "${url}"`,
    );
  }
  return response;
}

/**
 * Retries `download` up to `attempts` times, returning as soon as one succeeds. Only network
 * errors are retried — a rejected status (`UnacceptedStatusError`) throws immediately, since it's
 * a definitive response from the server rather than a transient failure. If every attempt fails
 * with a network error, throws an `AttemptsExhaustedError` wrapping the last one.
 */
async function downloadWithRetry(
  url: string | URL,
  init: RequestInit,
  attempts: number,
  acceptStatus: (statusCode: number) => boolean,
): Promise<Response> {
  const maxAttempts = Math.max(1, attempts);
  let lastError: unknown;
  let attempt = 0;

  do {
    try {
      return await download(url, init, acceptStatus);
    } catch (error) {
      if (error instanceof UnacceptedStatusError) throw error;
      lastError = error;
    }
    attempt++;
  } while (attempt < maxAttempts);

  throw new AttemptsExhaustedError(maxAttempts, lastError);
}

/**
 * Performs an HTTP request, retrying up to `attempts` times when the network fails. Throws an
 * `AttemptsExhaustedError` (wrapping the last network error) once every attempt is exhausted. A
 * response whose status is rejected by `acceptStatus` throws immediately, without retrying — it's
 * a definitive answer from the server, not treated as a transient failure. On an accepted
 * response, parses the body with `bodyParser` (default `(res) => res.json()`) — a `bodyParser`
 * failure is not retried and is thrown as-is.
 */
export async function httpFetch<T = unknown>(req: HttpFetchRequest<T>): Promise<HttpFetchResponse<T>> {
  const { url, method = "GET", headers, attempts = 1, acceptStatus = defaultAcceptStatus } = req;
  const bodyParser = req.bodyParser ?? defaultBodyParser<T>;
  const init: RequestInit = { method, headers };

  const response = await downloadWithRetry(url, init, attempts, acceptStatus);
  const body = await bodyParser(response);
  return { statusCode: response.status, headers: response.headers, body };
}
