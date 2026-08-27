import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Store } from "../utils/store";
import { sseDataSource } from "./sse";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** An SSE response whose body streams one `data: <line>` event per entry in `messages`. */
function sseResponse(messages: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const message of messages) {
        controller.enqueue(encoder.encode(`data: ${message}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Resolves once `store`'s value satisfies `predicate`, so tests don't race the background reader. */
function waitForValue<T>(store: Store<T>, predicate: (value: T) => boolean): Promise<T> {
  return new Promise((resolve) => {
    const unsubscribe = store.subscribe((value) => {
      if (predicate(value)) {
        // Deferred: `unsubscribe` isn't assigned yet if `subscribe` invokes this synchronously.
        queueMicrotask(() => unsubscribe());
        resolve(value);
      }
    });
  });
}

describe("sseDataSource", () => {
  test("applies each message as a shallow patch onto the accumulated state", async () => {
    globalThis.fetch = (async () =>
      sseResponse([JSON.stringify({ port: 3000 }), JSON.stringify({ host: "10.0.0.1" })])) as unknown as typeof fetch;

    const source = sseDataSource<{ port?: number; host?: string }>({ url: "https://example.com/events" });
    const store = await source.open();

    const final = await waitForValue(store, (value) => value?.host !== undefined);

    expect(final).toEqual({ port: 3000, host: "10.0.0.1" });
  });

  test("passes method and headers to fetch", async () => {
    let receivedInit: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      receivedInit = init;
      return sseResponse([JSON.stringify({ ok: true })]);
    }) as unknown as typeof fetch;

    const source = sseDataSource({
      url: "https://example.com/events",
      method: "POST",
      headers: { authorization: "Bearer token" },
    });
    const store = await source.open();
    await waitForValue(store, (value) => value !== null);

    expect(receivedInit?.method).toBe("POST");
    expect(receivedInit?.headers).toEqual({ authorization: "Bearer token" });
  });

  test("logs and skips a message that isn't valid JSON, without losing prior state", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = (async () => sseResponse(["{not json", JSON.stringify({ port: 3000 })])) as unknown as typeof fetch;

    const source = sseDataSource({ url: "https://example.com/events" });
    const store = await source.open();

    const final = await waitForValue(store, (value) => value !== null);

    expect(final).toEqual({ port: 3000 });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  test("logs and skips a message that doesn't parse to a JSON object", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = (async () => sseResponse(["42", JSON.stringify({ port: 3000 })])) as unknown as typeof fetch;

    const source = sseDataSource({ url: "https://example.com/events" });
    const store = await source.open();

    const final = await waitForValue(store, (value) => value !== null);

    expect(final).toEqual({ port: 3000 });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  test("logs and leaves the store empty when the connection fails", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const source = sseDataSource({ url: "https://example.com/events" });
    const store = await source.open();

    expect(store.get()).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  test("logs and leaves the store empty on a non-ok response", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;

    const source = sseDataSource({ url: "https://example.com/events" });
    const store = await source.open();

    expect(store.get()).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});
