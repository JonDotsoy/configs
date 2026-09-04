import { CounterMetric, HistogramMetric, type Metric } from "../utils/metric.js";
import { t } from "../utils/t.js";
import { Source } from "./source.js";

export interface PullSourceOptions<T = unknown> {
  /** Called on every round to produce a fresh snapshot. May be sync or async. */
  pull: () => T | Promise<T>;
  /** Milliseconds between calls to `pull`. */
  interval: number;
}

/** The metrics `pullSource` records, exposed as-is on the resulting `Source` via `source.metrics`. */
type PullSourceMetrics = Record<string, Metric> & {
  /** Rounds run (the initial one, and every `interval`-triggered one), labeled `ok` (`"true"` / `"false"`). */
  pulls: CounterMetric;
  /** How long each `pull()` call took, in seconds, labeled `ok` (`"true"` / `"false"`). */
  pullDuration: HistogramMetric;
};

function createMetrics(): PullSourceMetrics {
  return {
    pulls: new CounterMetric({
      name: "pull_source_pulls_total",
      help: "Total pull() rounds run by pullSource, labeled by outcome.",
      labelNames: ["ok"],
    }),
    pullDuration: new HistogramMetric({
      name: "pull_source_pull_duration_seconds",
      help: "How long each pullSource round took, in seconds, labeled by outcome.",
      labelNames: ["ok"],
    }),
  };
}

/** Runs one `pull()` call, logging and swallowing any failure into `undefined`. */
async function pullRound<T>(
  pull: () => T | Promise<T>,
  metrics: PullSourceMetrics,
): Promise<{ data: T } | undefined> {
  const startedAt = performance.now();
  const [ok, error, data] = await t(pull);
  const labels = { ok: String(ok) };
  metrics.pulls.inc(labels);
  metrics.pullDuration.observe(labels, (performance.now() - startedAt) / 1000);

  if (!ok) {
    console.error("pullSource: `pull` threw", error);
    return undefined;
  }

  return { data };
}

/**
 * A `Source` that calls `pull` on a fixed `interval` (in milliseconds) and publishes whatever it
 * returns as the next config tree snapshot. `pull` is called once immediately when the source
 * starts, then again every `interval` milliseconds until the `Source` is closed.
 *
 * A `pull` failure is logged via `console.error` and swallowed instead of thrown. If the very
 * first call fails, the source closes with an empty (`null`) store, same as `fetchSource`. A
 * failure on a later round is logged and skipped, keeping the last good value and the polling
 * running.
 *
 * Every round bumps two built-in metrics, exposed on the returned `Source` via `source.metrics`:
 * `pulls` (a `CounterMetric`) and `pullDuration` (a `HistogramMetric`, in seconds) — both labeled
 * `ok` (`"true"` / `"false"`).
 */
export function pullSource<T = unknown>(options: PullSourceOptions<T>): Source<T> {
  const { pull, interval } = options;
  const metrics = createMetrics();
  let timer: ReturnType<typeof setTimeout> | undefined;

  return new Source<T>({
    metrics,
    async start(control) {
      const first = await pullRound(pull, metrics);
      if (!first) {
        control.close();
        return;
      }

      control.set(first.data);

      const scheduleNext = () => {
        timer = setTimeout(async () => {
          const result = await pullRound(pull, metrics);
          if (result) control.set(result.data);
          scheduleNext();
        }, interval);
      };
      scheduleNext();
    },
    close() {
      clearTimeout(timer);
    },
  });
}
