import { spawn } from "node:child_process";
import { CounterMetric, HistogramMetric, type Metric } from "../utils/metric.js";
import { t } from "../utils/t.js";
import { selectTreePath } from "../utils/tree-path.js";
import { Source } from "./source.js";

export interface ShellSourceOptions<T = unknown> {
  /** Working directory for the spawned process. Defaults to the current process's cwd. */
  cwd?: string;
  /** Environment variables for the spawned process. Defaults to the current process's own env. */
  env?: Record<string, string | undefined>;
  /**
   * Kills the in-flight run (and stops retrying it) when the signal fires. Note this only covers
   * a single round — with `pollingInterval` set, later rounds still run; close the `Source` itself
   * to stop polling entirely.
   */
  signal?: AbortSignal;
  /** Runs to attempt before giving up. Defaults to 1 (no retry). */
  attempts?: number;
  /** Turns the process's stdout (decoded as UTF-8 text) into `T`. Defaults to `JSON.parse`. */
  stdoutParser?: (stdout: string) => T | Promise<T>;
  /**
   * Decides whether an exit code counts as accepted. Defaults to `(exitCode) => exitCode === 0`.
   */
  acceptExitCode?: (exitCode: number) => boolean;
  /**
   * Selects a subtree of the parsed stdout to use as the config tree instead of the whole thing,
   * same as `fetchSource`'s `treePath`. Defaults to `[]`: the whole parsed output is used.
   */
  treePath?: string[];
  /**
   * Milliseconds between runs. Defaults to `false`: `shellSource` runs `args` exactly once and
   * closes. Set it to a number to keep re-running `args` on that interval (each round retried up
   * to `attempts` times) until the `Source` is closed.
   */
  pollingInterval?: number | false;
  /**
   * Combines each successful run with the previously published value instead of replacing it
   * outright. Especially useful with `pollingInterval`, when a later round's output is a partial
   * update rather than a full snapshot. Receives the freshly run (and `treePath`-selected) output
   * as `incoming` and the last published value as `previous` (`null` before the first round).
   * Defaults to publishing `incoming` as-is — a full replace.
   */
  reduce?: (incoming: T, previous: T | null) => T;
  /**
   * Called once per run (including every polled run) with timing and outcome data. A throwing
   * `onRun` is not caught: keep it side-effect-only (e.g. logging or metrics).
   */
  onRun?: (event: ShellRunEvent) => void;
}

/** Passed to `onRun` once per run, on both success and failure. */
export interface ShellRunEvent {
  /** The command this round ran. */
  args: string[];
  /** Whether the round succeeded (an accepted exit code and a parseable stdout). */
  ok: boolean;
  /** The process's exit code. Absent when the round never produced one (e.g. every attempt failed to spawn). */
  exitCode?: number;
  /** The process's stderr, decoded as UTF-8. Absent when the round never produced one. */
  stderr?: string;
  /** Wall-clock time the round took, from just before its first attempt to its outcome, in milliseconds. */
  durationMs: number;
  /** The error that made the round fail. Only set when `ok` is `false`. */
  error?: unknown;
}

/** The metrics `shellSource` records, exposed as-is on the resulting `Source` via `source.metrics`. */
type ShellSourceMetrics = Record<string, Metric> & {
  /** Total runs run, labeled `ok` (`"true"` / `"false"`). */
  runs: CounterMetric;
  /** How long each run took, in seconds, labeled `ok` (`"true"` / `"false"`). */
  duration: HistogramMetric;
};

function createMetrics(): ShellSourceMetrics {
  return {
    runs: new CounterMetric({
      name: "shell_source_runs_total",
      help: "Total runs run by shellSource, labeled by outcome.",
      labelNames: ["ok"],
    }),
    duration: new HistogramMetric({
      name: "shell_source_run_duration_seconds",
      help: "How long each shellSource run took, in seconds, labeled by outcome.",
      labelNames: ["ok"],
    }),
  };
}

const defaultAcceptExitCode = (exitCode: number) => exitCode === 0;

/** Thrown by `runProcess` when a process's exit code is rejected by `acceptExitCode`. Not retried. */
class RejectedExitCodeError extends Error {
  constructor(args: string[], exitCode: number, stderr: string) {
    super(
      `shellSource: "${args.join(" ")}" exited with unexpected code ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
    );
    this.name = "RejectedExitCodeError";
  }
}

/** Thrown by `runWithRetry` when every attempt fails to produce an accepted exit code. */
class AttemptsExhaustedError extends Error {
  constructor(attempts: number, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`shellSource: failed after ${attempts} attempt(s): ${causeMessage}`, { cause });
    this.name = "AttemptsExhaustedError";
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runProcess(
  args: string[],
  cwd: string | undefined,
  env: Record<string, string | undefined> | undefined,
  signal: AbortSignal | undefined,
  acceptExitCode: (exitCode: number) => boolean,
): Promise<RunResult> {
  const [command, ...commandArgs] = args;
  const child = spawn(command!, commandArgs, { cwd, env, signal });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  if (!acceptExitCode(exitCode)) throw new RejectedExitCodeError(args, exitCode, stderr);
  return { stdout, stderr, exitCode };
}

/**
 * Retries `runProcess` up to `attempts` times, returning as soon as one succeeds. Only a failure
 * to run the process at all (e.g. the binary doesn't exist) is retried — a rejected exit code
 * (`RejectedExitCodeError`) or an abort (`signal` firing) throws immediately, since both are
 * definitive outcomes rather than transient failures. If every attempt fails to run, throws an
 * `AttemptsExhaustedError` wrapping the last one.
 */
async function runWithRetry(
  args: string[],
  cwd: string | undefined,
  env: Record<string, string | undefined> | undefined,
  signal: AbortSignal | undefined,
  attempts: number,
  acceptExitCode: (exitCode: number) => boolean,
): Promise<RunResult> {
  const maxAttempts = Math.max(1, attempts);
  let lastError: unknown;
  let attempt = 0;

  do {
    try {
      return await runProcess(args, cwd, env, signal, acceptExitCode);
    } catch (error) {
      if (error instanceof RejectedExitCodeError) throw error;
      if (isAbortError(error)) throw error;
      lastError = error;
    }
    attempt++;
  } while (attempt < maxAttempts);

  throw new AttemptsExhaustedError(maxAttempts, lastError);
}

type ShellRoundResult<T> = { data: T };

/** Runs one round (with retry), logging and swallowing any failure into `undefined`. */
async function shellRound<T>(
  args: string[],
  cwd: string | undefined,
  env: Record<string, string | undefined> | undefined,
  signal: AbortSignal | undefined,
  attempts: number,
  acceptExitCode: (exitCode: number) => boolean,
  stdoutParser: (stdout: string) => T | Promise<T>,
  onRun: ((event: ShellRunEvent) => void) | undefined,
  metrics: ShellSourceMetrics,
): Promise<ShellRoundResult<T> | undefined> {
  const startedAt = performance.now();
  const [ranOk, runError, result] = await t(() => runWithRetry(args, cwd, env, signal, attempts, acceptExitCode));
  const durationMs = performance.now() - startedAt;

  if (!ranOk) {
    metrics.runs.inc({ ok: "false" });
    metrics.duration.observe({ ok: "false" }, durationMs / 1000);
    console.error(`shellSource: failed to run "${args.join(" ")}"`, runError);
    onRun?.({ args, ok: false, durationMs, error: runError });
    return undefined;
  }

  const [parsedOk, parseError, data] = await t(() => stdoutParser(result.stdout));
  const labels = { ok: String(parsedOk) };
  metrics.runs.inc(labels);
  metrics.duration.observe(labels, durationMs / 1000);

  if (!parsedOk) {
    console.error(`shellSource: failed to parse stdout of "${args.join(" ")}"`, parseError);
    onRun?.({ args, ok: false, exitCode: result.exitCode, stderr: result.stderr, durationMs, error: parseError });
    return undefined;
  }

  onRun?.({ args, ok: true, exitCode: result.exitCode, stderr: result.stderr, durationMs });
  return { data };
}

/**
 * Selects `treePath` out of `data`, same as `fetchSource`/`fileSource`'s `treePath` — an empty
 * `treePath` is a no-op. A missing or non-object segment along the way is logged via
 * `console.error` but still publishes a snapshot: an empty object (`{}`), not `null` / the
 * previous value, since the run itself succeeded fine.
 */
function applyTreePath<T>(args: string[], data: T, treePath: string[]): T {
  if (treePath.length === 0) return data;

  const selected = selectTreePath(data, treePath);
  if (selected === undefined) {
    console.error(
      `shellSource: treePath [${treePath.map((k) => JSON.stringify(k)).join(", ")}] did not resolve to anything in the output of "${args.join(" ")}"`,
    );
    return {} as T;
  }
  return selected as T;
}

/**
 * A `Source` that runs `args` as a child process (via `node:child_process`'s `spawn`) and publishes its parsed
 * stdout as the config tree, e.g. `shellSource(["gh", "auth", "token", "--format", "json"])`. The
 * process's stdout is decoded as UTF-8 and turned into `T` by `stdoutParser` (defaulting to
 * `JSON.parse`), so non-JSON output is supported by passing a custom parser. A run whose exit code
 * is rejected by `acceptExitCode` (default: non-zero) or whose stdout fails to parse is logged via
 * `console.error` and swallowed instead of thrown, same as `fetchSource`.
 *
 * By default (`pollingInterval: false`) it runs `args` exactly once and closes. Set
 * `pollingInterval` to a number of milliseconds to keep re-running on that interval instead —
 * each round retried up to `attempts` times, updating the store on every successful run, until
 * the `Source` is closed. A failed round after the first one is logged and skipped, without
 * closing the source or stopping the polling.
 *
 * `treePath` selects a subtree of the parsed stdout to use as the config tree, same as
 * `fetchSource`'s option of the same name — applied on every round, including polled ones.
 *
 * `reduce` combines each round's output with the previously published value instead of replacing
 * it outright — handy with `pollingInterval` when later rounds return partial updates.
 *
 * `onRun` is called once per run (the first one and, with `pollingInterval`, every polled run
 * after it) with that round's outcome: whether it succeeded, its exit code, and how long it took.
 *
 * Every round also bumps two built-in metrics, exposed on the returned `Source` via
 * `source.metrics`: `runs` (a `CounterMetric`, one per round) and `duration` (a `HistogramMetric`,
 * in seconds) — both labeled `ok` (`"true"` / `"false"`).
 */
export function shellSource<T = unknown>(args: string[], options: ShellSourceOptions<T> = {}): Source<T> {
  const {
    cwd,
    env,
    signal,
    attempts = 1,
    acceptExitCode = defaultAcceptExitCode,
    treePath = [],
    pollingInterval = false,
    reduce,
    onRun,
  } = options;
  const stdoutParser = options.stdoutParser ?? ((stdout: string) => JSON.parse(stdout) as T);
  const metrics = createMetrics();
  let timer: ReturnType<typeof setTimeout> | undefined;

  return new Source<T>({
    metrics,
    async start(control) {
      const doRound = () =>
        shellRound(args, cwd, env, signal, attempts, acceptExitCode, stdoutParser, onRun, metrics);

      const first = await doRound();
      if (!first) {
        control.close();
        return;
      }
      control.set(applyTreePath(args, first.data, treePath));

      if (pollingInterval === false) {
        control.close();
        return;
      }

      const scheduleNext = () => {
        timer = setTimeout(async () => {
          const result = await doRound();
          if (result) control.set(applyTreePath(args, result.data, treePath));
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
