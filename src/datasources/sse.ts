import { DataSource } from "./datasource";

export interface SseDataSourceOptions {
  url: string | URL;
  method?: string;
  headers?: Bun.HeadersInit;
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
 * A `DataSource` that connects to a Server-Sent Events endpoint. Every message tries to parse as
 * JSON; a successful parse of a plain object is applied as a shallow patch onto the config tree
 * accumulated so far (new fields are added, existing ones overwritten, everything else kept) —
 * e.g. `{"port":3000}` then `{"host":"10.0.0.1"}` end up as `{ port: 3000, host: "10.0.0.1" }`.
 * A message that isn't valid JSON, or doesn't parse to a plain object, is logged via
 * `console.error` and skipped, without disturbing the accumulated state or the connection.
 */
export function sseDataSource<T = unknown>(options: SseDataSourceOptions): DataSource<T> {
  const { url, method = "GET", headers } = options;

  return new DataSource<T>({
    async start(control) {
      let response: Response;
      try {
        response = await fetch(url, { method, headers });
      } catch (error) {
        console.error(`sseDataSource: failed to connect to "${url}"`, error);
        control.close();
        return;
      }

      if (!response.ok || !response.body) {
        console.error(`sseDataSource: received ${response.status} ${response.statusText} from "${url}"`);
        control.close();
        return;
      }

      let state: Record<string, unknown> = {};

      readEvents(response.body, (rawEvent) => {
        const raw = extractData(rawEvent);
        if (raw === null || raw.trim() === "") return;

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          console.error(`sseDataSource: message from "${url}" is not valid JSON`, error);
          return;
        }

        if (!isPatch(parsed)) {
          console.error(`sseDataSource: message from "${url}" did not parse to a JSON object`, parsed);
          return;
        }

        state = { ...state, ...parsed };
        control.set(state as T);
      })
        .catch((error) => {
          console.error(`sseDataSource: connection to "${url}" ended with an error`, error);
        })
        .finally(() => control.close());
    },
  });
}
