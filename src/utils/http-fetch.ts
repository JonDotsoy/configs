import { maskSensitiveUrl } from "./sanitize-log.js";

/**
 * Authenticates the request by setting the `Authorization` header up front.
 * `{ basic: { username, password } }` sends `Basic <base64>`; `{ bearer: { token } }` sends
 * `Bearer <token>`.
 */
export type HttpFetchCredentials =
  | { basic: { username: string; password: string } }
  | { bearer: { token: string } };

export interface HttpFetchRequest<T = unknown> {
  url: string | URL;
  method?: string;
  headers?: RequestInit["headers"];
  /** Request body, passed through to `fetch` as-is (e.g. a JSON string, `FormData`, `Blob`). */
  body?: RequestInit["body"];
  /**
   * Aborts the request (and stops retrying) when the signal fires. An abort is treated as
   * definitive, not a transient network failure, so it is never retried.
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
   * `Basic <base64>`; `{ bearer: { token } }` sends `Bearer <token>`. Overrides any
   * `authorization` set in `headers`.
   */
  credentials?: HttpFetchCredentials;
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

export const defaultAcceptStatus = (statusCode: number) => statusCode >= 200 && statusCode < 300;
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

function withAuthorizationHeader(headers: RequestInit["headers"] | undefined, value: string): Headers {
  const result = new Headers(headers);
  result.set("authorization", value);
  return result;
}

/** Sets the `Authorization` header from `credentials`, if given; passes `headers` through unchanged otherwise. */
export function applyCredentials(
  headers: RequestInit["headers"] | undefined,
  credentials: HttpFetchCredentials | undefined,
): RequestInit["headers"] | undefined {
  if (!credentials) return headers;
  if ("basic" in credentials) {
    const { username, password } = credentials.basic;
    return withAuthorizationHeader(headers, `Basic ${btoa(`${username}:${password}`)}`);
  }
  return withAuthorizationHeader(headers, `Bearer ${credentials.bearer.token}`);
}

async function download(
  url: string | URL,
  init: RequestInit,
  acceptStatus: (statusCode: number) => boolean,
): Promise<Response> {
  const response = await fetch(url, init);
  if (!acceptStatus(response.status)) {
    throw new UnacceptedStatusError(
      `httpFetch: received unexpected status ${response.status} ${response.statusText} from "${maskSensitiveUrl(url)}"`,
    );
  }
  return response;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Retries `download` up to `attempts` times, returning as soon as one succeeds. Only network
 * errors are retried — a rejected status (`UnacceptedStatusError`) or an abort (`init.signal`
 * firing) throws immediately, since both are definitive outcomes rather than transient failures.
 * If every attempt fails with a network error, throws an `AttemptsExhaustedError` wrapping the
 * last one. Returns the raw `Response` (unlike `httpFetch`, no `bodyParser` is applied), so a
 * caller that needs the live body stream — like `sseSource` — can consume it directly.
 */
export async function downloadWithRetry(
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
      if (isAbortError(error)) throw error;
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
  const {
    url,
    method = "GET",
    headers,
    body: reqBody,
    signal,
    mode,
    cache,
    redirect,
    credentials,
    attempts = 1,
    acceptStatus = defaultAcceptStatus,
  } = req;
  const bodyParser = req.bodyParser ?? defaultBodyParser<T>;
  const init: RequestInit = {
    method,
    headers: applyCredentials(headers, credentials),
    body: reqBody,
    signal,
    mode,
    cache,
    redirect,
  };

  const response = await downloadWithRetry(url, init, attempts, acceptStatus);
  const body = await bodyParser(response);
  return { statusCode: response.status, headers: response.headers, body };
}
