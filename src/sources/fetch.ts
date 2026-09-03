import { httpFetch, type HttpFetchCredentials, type HttpFetchRequest } from "../utils/http-fetch.js";
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

/** Runs one `httpFetch` round, logging and swallowing any failure into `undefined`. */
async function fetchRound<T>(
  req: HttpFetchRequest<T>,
  onFetched: ((event: FetchedEvent) => void) | undefined,
  metrics: FetchSourceMetrics,
): Promise<{ data: T } | undefined> {
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
  return { data: result.body };
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
 * `treePath` selects a subtree of the fetched body to use as the config tree, same as
 * `fileSource`'s option of the same name — applied on every round, including polled ones.
 *
 * `reduce` combines each round's body with the previously published value instead of replacing
 * it outright — handy with `pollingInterval` when later rounds return partial updates.
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
    treePath = [],
    reduce,
    onFetched,
  } = options;
  const req = {
    url,
    method,
    headers,
    body,
    signal,
    mode,
    cache,
    redirect,
    credentials,
    attempts,
    bodyParser,
    acceptStatus,
  };
  const metrics = createMetrics();
  let timer: ReturnType<typeof setTimeout> | undefined;

  return new Source<T>({
    metrics,
    async start(control) {
      const first = await fetchRound<T>(req, onFetched, metrics);
      if (!first) {
        control.close();
        return;
      }

      control.set(applyTreePath(url, first.data, treePath));

      if (pollingInterval === false) {
        control.close();
        return;
      }

      const scheduleNext = () => {
        timer = setTimeout(async () => {
          const result = await fetchRound<T>(req, onFetched, metrics);
          if (result) control.set(applyTreePath(url, result.data, treePath));
          scheduleNext();
        }, pollingInterval);
      };
      scheduleNext();
    },
    close() {
      clearTimeout(timer);
    },
    reduce,
  });
}
