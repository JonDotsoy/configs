import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Store } from "../utils/store";
import { sseSource } from "./sse";

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

/** An SSE response that streams `messages` one at a time, waiting for `release()` before each. */
function controlledSseResponse(messages: string[]): { response: Response; release: () => void } {
  let release = () => {};
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      for (const message of messages) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        controller.enqueue(encoder.encode(`data: ${message}\n\n`));
      }
      controller.close();
    },
  });
  return {
    response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    release: () => release(),
  };
}

/** An SSE response that emits one message, then stays open (simulating a live connection) until `signal` aborts. */
function hangingSseResponse(firstMessage: string, signal: AbortSignal | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${firstMessage}\n\n`));
      signal?.addEventListener("abort", () => {
        controller.error(new DOMException("The operation was aborted.", "AbortError"));
      });
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

describe("sseSource", () => {
  test("open() resolves only after the first message, already applied", async () => {
    const { response, release } = controlledSseResponse([JSON.stringify({ port: 3000 })]);
    globalThis.fetch = (async () => response) as unknown as typeof fetch;

    const source = sseSource<{ port?: number }>({ url: "https://example.com/events" });

    let opened = false;
    const openPromise = source.open().then((store) => {
      opened = true;
      return store;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(opened).toBe(false); // still waiting on the resource's first message

    release();
    const store = await openPromise;

    expect(opened).toBe(true);
    expect(store.get()).toEqual({ port: 3000 });
  });

  test("stays connected after open() and keeps applying messages as patches", async () => {
    const { response, release } = controlledSseResponse([
      JSON.stringify({ port: 3000 }),
      JSON.stringify({ host: "10.0.0.1" }),
    ]);
    globalThis.fetch = (async () => response) as unknown as typeof fetch;

    const source = sseSource<{ port?: number; host?: string }>({ url: "https://example.com/events" });

    release(); // let the first message through so open() can resolve
    const store = await source.open();

    // The first message is already applied by the time `open()` resolves.
    expect(store.get()).toEqual({ port: 3000 });

    release(); // the connection is still alive: let the second message through
    const final = await waitForValue(store, (value) => value?.host !== undefined);

    expect(final).toEqual({ port: 3000, host: "10.0.0.1" });
  });

  test("passes method and headers to fetch", async () => {
    let receivedInit: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      receivedInit = init;
      return sseResponse([JSON.stringify({ ok: true })]);
    }) as unknown as typeof fetch;

    const source = sseSource({
      url: "https://example.com/events",
      method: "POST",
      headers: { authorization: "Bearer token" },
    });
    const store = await source.open();

    expect(store.get()).toEqual({ ok: true });
    expect(receivedInit?.method).toBe("POST");
    expect(receivedInit?.headers).toEqual({ authorization: "Bearer token" });
  });

  test("logs and skips a message that isn't valid JSON, without losing prior state", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = (async () => sseResponse(["{not json", JSON.stringify({ port: 3000 })])) as unknown as typeof fetch;

    const source = sseSource({ url: "https://example.com/events" });
    const store = await source.open();

    expect(store.get()).toEqual({ port: 3000 });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  test("logs and skips a message that doesn't parse to a JSON object", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = (async () => sseResponse(["42", JSON.stringify({ port: 3000 })])) as unknown as typeof fetch;

    const source = sseSource({ url: "https://example.com/events" });
    const store = await source.open();

    expect(store.get()).toEqual({ port: 3000 });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  test("resolves open() with an empty store when the connection closes without any valid message", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = (async () => sseResponse(["{not json"])) as unknown as typeof fetch;

    const source = sseSource({ url: "https://example.com/events" });
    const store = await source.open();

    expect(store.get()).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  test("logs and leaves the store empty when the connection fails", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const source = sseSource({ url: "https://example.com/events" });
    const store = await source.open();

    expect(store.get()).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  test("logs and leaves the store empty on a non-ok response", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;

    const source = sseSource({ url: "https://example.com/events" });
    const store = await source.open();

    expect(store.get()).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  test("close() aborts the connection, without logging an error", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    let receivedSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      receivedSignal = init?.signal ?? undefined;
      return hangingSseResponse(JSON.stringify({ port: 3000 }), receivedSignal);
    }) as unknown as typeof fetch;

    const source = sseSource<{ port?: number }>({ url: "https://example.com/events" });
    const store = await source.open();

    expect(store.get()).toEqual({ port: 3000 });
    expect(receivedSignal?.aborted).toBe(false);

    await source.close();
    await Promise.resolve();

    expect(receivedSignal?.aborted).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
