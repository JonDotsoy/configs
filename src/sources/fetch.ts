import { parseCacheControl } from "../utils/cache-control.js";
import {
  defaultAcceptStatus,
  httpFetch,
  type HttpFetchCredentials,
  type HttpFetchRequest,
} from "../utils/http-fetch.js";
import { CounterMetric, HistogramMetric, type Metric } from "../utils/metric.js";
import { t } from "../utils/t.js";
import { selectTreePath } from "../utils/tree-path.js";
import { Source } from "./source.js";

export type { HttpFetchCredentials };

export interface FetchSourceOptions<T = unknown> {
  url: string | URL;
  method?: string;
  headers?: RequestInit["headers"];
  /** Request body, passed through to `fetch` as-is (e.g. a JSON string, `FormData`, `Blob`). */
  body?: RequestInit["body"];
  /**
   * Aborts the in-flight fetch (and stops retrying it) when the signal fires. Note this only
   * covers a single round — with `pollingInterval` set, later rounds still run; close the
   * `Source` itself to stop polling entirely.
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
  /**
   * Follows the response's `Cache-Control` header to decide when to fetch again, instead of (or
   * as a fallback for) `pollingInterval`. A response carrying `max-age=<seconds>` schedules the
   * next fetch that many seconds out; `no-store`/`no-cache` (or `max-age=0`) schedules it
   * immediately. Setting this to `true` starts polling even with `pollingInterval` left at its
   * `false` default — polling then continues only as long as responses keep specifying a cache
   * lifetime. If a response's `Cache-Control` header is missing `max-age` and doesn't say
   * `no-store`/`no-cache`, that round falls back to `pollingInterval` (running once and stopping
   * if `pollingInterval` is also `false`). Defaults to `false`: cadence is driven purely by
   * `pollingInterval`.
   */
  followCacheControl?: boolean;
  /**
   * Sends a conditional GET on every round after the first, using the `ETag`/`Last-Modified`
   * headers from the previous response: an `ETag` is echoed back as `If-None-Match`, and
   * `Last-Modified` as `If-Modified-Since`. A `304 Not Modified` reply is treated as "still the
   * same" — it's accepted (not a rejected status), its (empty) body is skipped, and the store
   * keeps its last published value instead of being overwritten. Only meaningful for a source
   * that fetches more than once — pair it with `pollingInterval` and/or `followCacheControl`.
   * Defaults to `true`; set it to `false` to make every round send a plain, unconditional GET.
   */
  useConditionalRequests?: boolean;
  /**
   * Selects a subtree of the fetched body to use as the config tree instead of the whole thing,
   * e.g. `["containers", "settings"]` to use `{ containers: { settings: {...} } }`'s inner object
   * and ignore the rest of the response. Defaults to `[]`: the whole body is used, unchanged.
   */
  treePath?: string[];
  /**
   * Combines each successful fetch with the previously published value instead of replacing it
   * outright. Especially useful with `pollingInterval`, when a later round's response is a
   * partial update rather than a full snapshot. Receives the freshly fetched (and
   * `treePath`-selected) body as `incoming` and the last published value as `previous` (`null`
   * before the first round). Defaults to publishing `incoming` as-is — a full replace.
   */
  reduce?: (incoming: T, previous: T | null) => T;
  /**
   * Called once per fetch round (including every polled round) with timing and outcome data.
   * A throwing `onFetched` is not caught: keep it side-effect-only (e.g. logging or metrics).
   */
  onFetched?: (event: FetchedEvent) => void;
}

/** Passed to `onFetched` once per fetch round, on both success and failure. */
export interface FetchedEvent {
  /** The `url` this round fetched. */
  url: string | URL;
  /** Whether the round succeeded (a response was accepted by `acceptStatus` and parsed). */
  ok: boolean;
  /** The response's status code. Absent when the round never reached a response (network failure). */
  statusCode?: number;
  /** Wall-clock time the round took, from just before its first attempt to its outcome, in milliseconds. */
  durationMs: number;
  /** The error that made the round fail. Only set when `ok` is `false`. */
  error?: unknown;
}

/** The metrics `fetchSource` records, exposed as-is on the resulting `Source` via `source.metrics`. */
type FetchSourceMetrics = Record<string, Metric> & {
  /** Total fetch rounds run, labeled `ok` (`"true"` / `"false"`). */
  requests: CounterMetric;
  /** How long each round took, in seconds, labeled `ok` (`"true"` / `"false"`). */
  duration: HistogramMetric;
};

function createMetrics(): FetchSourceMetrics {
  return {
    requests: new CounterMetric({
      name: "fetch_source_requests_total",
      help: "Total fetch rounds run by fetchSource, labeled by outcome.",
      labelNames: ["ok"],
    }),
    duration: new HistogramMetric({
      name: "fetch_source_request_duration_seconds",
      help: "How long each fetchSource round took, in seconds, labeled by outcome.",
      labelNames: ["ok"],
    }),
  };
}

type FetchRoundResult<T> = { notModified: true; headers: Headers } | { data: T; headers: Headers };

/**
 * Runs one `httpFetch` round, logging and swallowing any failure into `undefined`. A `304`
 * response (only ever seen when `req.acceptStatus` was widened to accept it, i.e. with
 * `useConditionalRequests`) comes back as `{ notModified: true }` instead of `{ data }`.
 */
async function fetchRound<T>(
  req: HttpFetchRequest<T>,
  onFetched: ((event: FetchedEvent) => void) | undefined,
  metrics: FetchSourceMetrics,
): Promise<FetchRoundResult<T> | undefined> {
  const startedAt = performance.now();
  const [ok, error, result] = await t(() => httpFetch<T>(req));
  const durationMs = performance.now() - startedAt;
  const labels = { ok: String(ok) };
  metrics.requests.inc(labels);
  metrics.duration.observe(labels, durationMs / 1000);

  if (!ok) {
    console.error(`fetchSource: failed to fetch "${req.url}"`, error);
    onFetched?.({ url: req.url, ok: false, durationMs, error });
    return undefined;
  }

  onFetched?.({ url: req.url, ok: true, statusCode: result.statusCode, durationMs });
  if (result.statusCode === 304) return { notModified: true, headers: result.headers };
  return { data: result.body, headers: result.headers };
}

/**
 * Adds `If-None-Match`/`If-Modified-Since` to `baseHeaders` from the last round's `ETag`/
 * `Last-Modified`, for `useConditionalRequests`. Returns `baseHeaders` unchanged when neither is
 * known yet (e.g. the very first round).
 */
function withConditionalHeaders(
  baseHeaders: RequestInit["headers"] | undefined,
  etag: string | null,
  lastModified: string | null,
): RequestInit["headers"] | undefined {
  if (!etag && !lastModified) return baseHeaders;
  const merged = new Headers(baseHeaders);
  if (etag) merged.set("if-none-match", etag);
  if (lastModified) merged.set("if-modified-since", lastModified);
  return merged;
}

/**
 * Decides the delay, in milliseconds, before the next poll. When `followCacheControl` is set,
 * a response's `Cache-Control` header takes priority: `no-store`/`no-cache` means "fetch again
 * immediately" (`0`), `max-age=<seconds>` converts straight to milliseconds, and a header with
 * neither (or no header at all) falls back to `pollingInterval`. `pollingInterval` is used as-is
 * when `followCacheControl` is off.
 */
function resolveNextDelay(
  headers: Headers,
  pollingInterval: number | false,
  followCacheControl: boolean,
): number | false {
  if (followCacheControl) {
    const directives = parseCacheControl(headers.get("cache-control"));
    if (directives.noStore || directives.noCache) return 0;
    if (directives.maxAge !== undefined) return directives.maxAge * 1000;
  }
  return pollingInterval;
}

/**
 * Selects `treePath` out of `data`, same as `fileSource`'s `treePath` — an empty `treePath` is a
 * no-op. A missing or non-object segment along the way is logged via `console.error` but still
 * publishes a snapshot: an empty object (`{}`), not `null` / the previous value, since the fetch
 * itself succeeded fine.
 */
function applyTreePath<T>(url: string | URL, data: T, treePath: string[]): T {
  if (treePath.length === 0) return data;

  const selected = selectTreePath(data, treePath);
  if (selected === undefined) {
    console.error(
      `fetchSource: treePath [${treePath.map((k) => JSON.stringify(k)).join(", ")}] did not resolve to anything in the response from "${url}"`,
    );
    return {} as T;
  }
  return selected as T;
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
 *
 * `followCacheControl` lets the server drive that cadence instead: each response's
 * `Cache-Control` header (`max-age`, `no-store`/`no-cache`) decides when the next fetch happens,
 * falling back to `pollingInterval` for any round whose response doesn't specify one. Set alone
 * (with `pollingInterval` left `false`), it starts polling purely off what the server reports.
 *
 * `treePath` selects a subtree of the fetched body to use as the config tree, same as
 * `fileSource`'s option of the same name — applied on every round, including polled ones.
 *
 * `reduce` combines each round's body with the previously published value instead of replacing
 * it outright — handy with `pollingInterval` when later rounds return partial updates.
 *
 * `useConditionalRequests` (on by default) makes every round after the first a conditional GET,
 * echoing back the previous response's `ETag`/`Last-Modified` as `If-None-Match`/
 * `If-Modified-Since`; a `304` reply is accepted and simply skipped, leaving the store at its
 * last published value. Set it to `false` to always send a plain, unconditional GET.
 *
 * `onFetched` is called once per fetch round (the first round and, with `pollingInterval`, every
 * polled round after it) with that round's outcome: whether it succeeded, its status code, and how
 * long it took.
 *
 * Every round also bumps two built-in metrics, exposed on the returned `Source` via `source.metrics`:
 * `requests` (a `CounterMetric`, one per round) and `duration` (a `HistogramMetric`, in seconds) —
 * both labeled `ok` (`"true"` / `"false"`).
 */
export function fetchSource<T = unknown>(options: FetchSourceOptions<T>): Source<T> {
  const {
    url,
    method = "GET",
    headers,
    body,
    signal,
    mode,
    cache,
    redirect,
    credentials,
    attempts = 1,
    bodyParser,
    acceptStatus,
    pollingInterval = false,
    followCacheControl = false,
    useConditionalRequests = true,
    treePath = [],
    reduce,
    onFetched,
  } = options;
  const effectiveAcceptStatus = useConditionalRequests
    ? (statusCode: number) => statusCode === 304 || (acceptStatus ?? defaultAcceptStatus)(statusCode)
    : acceptStatus;
  const parseBody = bodyParser ?? ((res: Response) => res.json() as Promise<T>);
  const effectiveBodyParser = useConditionalRequests
    ? async (res: Response) => (res.status === 304 ? (undefined as T) : parseBody(res))
    : bodyParser;
  const req = {
    url,
    method,
    body,
    signal,
    mode,
    cache,
    redirect,
    credentials,
    attempts,
    bodyParser: effectiveBodyParser,
    acceptStatus: effectiveAcceptStatus,
  };
  const metrics = createMetrics();
  let timer: ReturnType<typeof setTimeout> | undefined;

  return new Source<T>({
    metrics,
    async start(control) {
      let etag: string | null = null;
      let lastModified: string | null = null;

      const doRound = () =>
        fetchRound<T>(
          {
            ...req,
            headers: useConditionalRequests ? withConditionalHeaders(headers, etag, lastModified) : headers,
          },
          onFetched,
          metrics,
        );

      const publish = (result: FetchRoundResult<T>) => {
        if ("notModified" in result) return;
        control.set(applyTreePath(url, result.data, treePath));
        if (useConditionalRequests) {
          etag = result.headers.get("etag");
          lastModified = result.headers.get("last-modified");
        }
      };

      const first = await doRound();
      if (!first) {
        control.close();
        return;
      }
      publish(first);

      const delay = resolveNextDelay(first.headers, pollingInterval, followCacheControl);
      if (delay === false) {
        control.close();
        return;
      }

      const scheduleNext = (nextDelay: number) => {
        timer = setTimeout(async () => {
          const result = await doRound();
          if (!result) {
            scheduleNext(nextDelay);
            return;
          }
          publish(result);
          const resolved = resolveNextDelay(result.headers, pollingInterval, followCacheControl);
          if (resolved === false) return;
          scheduleNext(resolved);
        }, nextDelay);
      };
      scheduleNext(delay);
    },
    close() {
      clearTimeout(timer);
    },
    reduce,
  });
}
