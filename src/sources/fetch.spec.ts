import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { CounterMetric, HistogramMetric } from "../utils/metric";
import { fetchSource } from "./fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(
  body: string,
  init: {
    status?: number;
    contentType?: string;
    cacheControl?: string;
    etag?: string;
    lastModified?: string;
  } = {},
): Response {
  const headers: Record<string, string> = { "content-type": init.contentType ?? "application/json" };
  if (init.cacheControl !== undefined) headers["cache-control"] = init.cacheControl;
  if (init.etag !== undefined) headers["etag"] = init.etag;
  if (init.lastModified !== undefined) headers["last-modified"] = init.lastModified;
  return new Response(body, {
    status: init.status ?? 200,
    headers,
  });
}

describe("fetchSource", () => {
  test("fetches and parses a JSON response", async () => {
    let receivedUrl: string | URL | undefined;
    let receivedInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      receivedUrl = url;
      receivedInit = init;
      return jsonResponse(JSON.stringify({ port: 3000 }));
    }) as unknown as typeof fetch;

    const source = fetchSource<{ port: number }>({
      url: "https://example.com/config",
      method: "POST",
      headers: { authorization: "Bearer token" },
    });
    const store = await source.open();

    expect(store.get()).toEqual({ port: 3000 });
    expect(receivedUrl).toBe("https://example.com/config");
    expect(receivedInit?.method).toBe("POST");
    expect(receivedInit?.headers).toEqual({ authorization: "Bearer token" });
  });

  test("falls back to parsing the body as JSON when content-type isn't json", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(JSON.stringify({ port: 3000 }), { contentType: "text/plain" })) as unknown as typeof fetch;

    const source = fetchSource({ url: "https://example.com/config" });
    const store = await source.open();

    expect(store.get()).toEqual({ port: 3000 });
  });

  test("uses a custom bodyParser instead of the default JSON parsing", async () => {
    globalThis.fetch = (async () => jsonResponse(JSON.stringify({ port: 3000 }))) as unknown as typeof fetch;

    const source = fetchSource<string>({
      url: "https://example.com/config",
      bodyParser: async (res) => res.text(),
    });
    const store = await source.open();

    expect(store.get()).toBe(JSON.stringify({ port: 3000 }));
  });

  test("logs and leaves the store empty when a custom bodyParser throws", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = (async () => jsonResponse(JSON.stringify({ port: 3000 }))) as unknown as typeof fetch;

    const source = fetchSource({
      url: "https://example.com/config",
      bodyParser: async () => {
        throw new Error("parse failed");
      },
    });
    const store = await source.open();

    expect(store.get()).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  test("masks a sensitive query parameter's value in the console.error log for a failed fetch", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const source = fetchSource({ url: "https://example.com/config?token=s3cr3t-value" });
    await source.open();

    const logged = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).toContain("****");
    expect(logged).not.toContain("s3cr3t-value");
    errorSpy.mockRestore();
  });

  test("never leaks a sensitive header's value into the console.error log for a failed fetch", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const source = fetchSource({
      url: "https://example.com/config",
      headers: { authorization: "Bearer s3cr3t-header-value" },
    });
    await source.open();

    const logged = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).not.toContain("s3cr3t-header-value");
    errorSpy.mockRestore();
  });

  test("masks a Basic-auth password embedded in the URL in the console.error log for a failed fetch", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const source = fetchSource({ url: "https://user:s3cr3t-password@example.com/api/resource" });
    await source.open();

    const logged = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).toContain("****");
    expect(logged).toContain("user:****@example.com");
    expect(logged).not.toContain("s3cr3t-password");
    errorSpy.mockRestore();
  });

  test("a custom acceptStatus can accept a status the default would reject", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(JSON.stringify({ found: false }), { status: 404 })) as unknown as typeof fetch;

    const source = fetchSource<{ found: boolean }>({
      url: "https://example.com/config",
      acceptStatus: (statusCode) => statusCode === 404,
    });
    const store = await source.open();

    expect(store.get()).toEqual({ found: false });
  });

  test("logs and leaves the store empty when the body isn't valid JSON", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = (async () => jsonResponse("not json")) as unknown as typeof fetch;

    const source = fetchSource({ url: "https://example.com/config" });
    const store = await source.open();

    expect(store.get()).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  test("defaults to a single attempt: one failure logs and leaves the store empty", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const source = fetchSource({ url: "https://example.com/config" });
    const store = await source.open();

    expect(calls).toBe(1);
    expect(store.get()).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  test("retries up to `attempts` times before succeeding", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls < 3) throw new Error("network down");
      return jsonResponse(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;

    const source = fetchSource({ url: "https://example.com/config", attempts: 3 });
    const store = await source.open();

    expect(calls).toBe(3);
    expect(store.get()).toEqual({ ok: true });
  });

  test("a non-ok response is not retried: logs and leaves the store empty immediately", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse("", { status: 500 });
    }) as unknown as typeof fetch;

    const source = fetchSource({ url: "https://example.com/config", attempts: 2 });
    const store = await source.open();

    expect(calls).toBe(1);
    expect(store.get()).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  describe("pollingInterval", () => {
    test("defaults to off: fetches once and never polls again", async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return jsonResponse(JSON.stringify({ port: 3000 }));
      }) as unknown as typeof fetch;

      const source = fetchSource({ url: "https://example.com/config" });
      await source.open();
      await Bun.sleep(20);

      expect(calls).toBe(1);
    });

    test("keeps fetching on the given interval, updating the store each time", async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return jsonResponse(JSON.stringify({ port: calls }));
      }) as unknown as typeof fetch;

      const source = fetchSource<{ port: number }>({
        url: "https://example.com/config",
        pollingInterval: 5,
      });
      const store = await source.open();

      expect(store.get()).toEqual({ port: 1 });

      await Bun.sleep(30);

      expect(calls).toBeGreaterThan(1);
      expect(store.get()).toEqual({ port: calls });

      await source.close();
    });

    test("close() stops the polling", async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return jsonResponse(JSON.stringify({ port: calls }));
      }) as unknown as typeof fetch;

      const source = fetchSource({ url: "https://example.com/config", pollingInterval: 5 });
      await source.open();
      await source.close();
      const callsAfterClose = calls;

      await Bun.sleep(30);

      expect(calls).toBe(callsAfterClose);
    });

    test("a failed round after the first keeps polling instead of closing", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        if (calls === 2) return jsonResponse("not json");
        return jsonResponse(JSON.stringify({ port: calls }));
      }) as unknown as typeof fetch;

      const source = fetchSource<{ port: number }>({
        url: "https://example.com/config",
        pollingInterval: 5,
      });
      const store = await source.open();

      await Bun.sleep(35);

      expect(calls).toBeGreaterThan(2);
      expect(store.get()).not.toBeNull();
      expect(errorSpy).toHaveBeenCalled();

      await source.close();
      errorSpy.mockRestore();
    });
  });

  describe("treePath", () => {
    test("selects a nested subtree, ignoring everything else in the response", async () => {
      globalThis.fetch = (async () =>
        jsonResponse(
          JSON.stringify({
            containers: { settings: { port: 3000, host: "localhost" } },
            metadata: { generatedAt: "2024-01-01" },
          }),
        )) as unknown as typeof fetch;

      const source = fetchSource({
        url: "https://example.com/config",
        treePath: ["containers", "settings"],
      });
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000, host: "localhost" });
    });

    test("a leaf value at treePath is used as-is, not just objects", async () => {
      globalThis.fetch = (async () =>
        jsonResponse(JSON.stringify({ server: { port: 3000 } }))) as unknown as typeof fetch;

      const source = fetchSource({
        url: "https://example.com/config",
        treePath: ["server", "port"],
      });
      const store = await source.open();

      expect(store.get()).toBe(3000);
    });

    test("an empty treePath (or omitting it) uses the whole body, same as the default", async () => {
      globalThis.fetch = (async () => jsonResponse(JSON.stringify({ port: 3000 }))) as unknown as typeof fetch;

      const source = fetchSource({ url: "https://example.com/config", treePath: [] });
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000 });
    });

    test("logs and sets an empty object when treePath doesn't resolve to anything", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      globalThis.fetch = (async () => jsonResponse(JSON.stringify({ containers: {} }))) as unknown as typeof fetch;

      const source = fetchSource({
        url: "https://example.com/config",
        treePath: ["containers", "settings"],
      });
      const store = await source.open();

      expect(store.get()).toEqual({});
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    test("is applied on every polled round, not just the first", async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return jsonResponse(JSON.stringify({ containers: { settings: { port: calls } } }));
      }) as unknown as typeof fetch;

      const source = fetchSource<{ port: number }>({
        url: "https://example.com/config",
        treePath: ["containers", "settings"],
        pollingInterval: 5,
      });
      const store = await source.open();

      expect(store.get()).toEqual({ port: 1 });

      await Bun.sleep(30);

      expect(calls).toBeGreaterThan(1);
      expect(store.get()).toEqual({ port: calls });

      await source.close();
    });
  });

  describe("onFetched", () => {
    test("reports a successful round with its status code and duration", async () => {
      globalThis.fetch = (async () => jsonResponse(JSON.stringify({ port: 3000 }))) as unknown as typeof fetch;

      const events: Array<{ ok: boolean; statusCode?: number; durationMs: number; error?: unknown }> = [];
      const source = fetchSource({
        url: "https://example.com/config",
        onFetched: (event) => events.push(event),
      });
      await source.open();

      expect(events).toHaveLength(1);
      expect(events[0]?.ok).toBe(true);
      expect(events[0]?.statusCode).toBe(200);
      expect(events[0]?.durationMs).toBeGreaterThanOrEqual(0);
      expect(events[0]?.error).toBeUndefined();
    });

    test("reports a failed round with its error and no status code", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      globalThis.fetch = (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch;

      const events: Array<{ ok: boolean; statusCode?: number; error?: unknown }> = [];
      const source = fetchSource({
        url: "https://example.com/config",
        onFetched: (event) => events.push(event),
      });
      await source.open();

      expect(events).toHaveLength(1);
      expect(events[0]?.ok).toBe(false);
      expect(events[0]?.statusCode).toBeUndefined();
      expect(events[0]?.error).toBeInstanceOf(Error);
      errorSpy.mockRestore();
    });

    test("reports one event per polled round", async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return jsonResponse(JSON.stringify({ port: calls }));
      }) as unknown as typeof fetch;

      const events: unknown[] = [];
      const source = fetchSource({
        url: "https://example.com/config",
        pollingInterval: 5,
        onFetched: (event) => events.push(event),
      });
      await source.open();

      await Bun.sleep(30);

      expect(events.length).toBe(calls);
      await source.close();
    });
  });

  describe("metrics", () => {
    test("bumps requests and duration, labeled ok=true, on a successful round", async () => {
      globalThis.fetch = (async () => jsonResponse(JSON.stringify({ port: 3000 }))) as unknown as typeof fetch;

      const source = fetchSource({ url: "https://example.com/config" });
      await source.open();
      const requests = source.metrics.requests as CounterMetric;
      const duration = source.metrics.duration as HistogramMetric;

      expect(requests.get({ ok: "true" })).toBe(1);
      expect(requests.get({ ok: "false" })).toBe(0);
      expect(duration.get({ ok: "true" }).count).toBe(1);
    });

    test("bumps requests and duration, labeled ok=false, on a failed round", async () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      globalThis.fetch = (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch;

      const source = fetchSource({ url: "https://example.com/config" });
      await source.open();
      const requests = source.metrics.requests as CounterMetric;
      const duration = source.metrics.duration as HistogramMetric;

      expect(requests.get({ ok: "false" })).toBe(1);
      expect(requests.get({ ok: "true" })).toBe(0);
      expect(duration.get({ ok: "false" }).count).toBe(1);
      errorSpy.mockRestore();
    });

    test("accumulates one observation per polled round", async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return jsonResponse(JSON.stringify({ port: calls }));
      }) as unknown as typeof fetch;

      const source = fetchSource({ url: "https://example.com/config", pollingInterval: 5 });
      await source.open();
      const requests = source.metrics.requests as CounterMetric;

      await Bun.sleep(30);

      expect(requests.get({ ok: "true" })).toBe(calls);
      await source.close();
    });
  });

  describe("followCacheControl", () => {
    test("off by default: pollingInterval alone drives the cadence", async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return jsonResponse(JSON.stringify({ port: calls }), { cacheControl: "max-age=100" });
      }) as unknown as typeof fetch;

      const source = fetchSource<{ port: number }>({
        url: "https://example.com/config",
        pollingInterval: 5,
      });
      const store = await source.open();

      await Bun.sleep(30);

      expect(calls).toBeGreaterThan(1);
      expect(store.get()).toEqual({ port: calls });

      await source.close();
    });

    test("schedules the next fetch after max-age seconds, ignoring pollingInterval", async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return jsonResponse(JSON.stringify({ port: calls }), { cacheControl: "max-age=0.01" });
      }) as unknown as typeof fetch;

      const source = fetchSource<{ port: number }>({
        url: "https://example.com/config",
        pollingInterval: 10_000,
        followCacheControl: true,
      });
      const store = await source.open();

      expect(store.get()).toEqual({ port: 1 });

      await Bun.sleep(30);

      expect(calls).toBeGreaterThan(1);
      expect(store.get()).toEqual({ port: calls });

      await source.close();
    });

    test("starts polling purely from the header even with pollingInterval left at false", async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return jsonResponse(JSON.stringify({ port: calls }), { cacheControl: "max-age=0.01" });
      }) as unknown as typeof fetch;

      const source = fetchSource<{ port: number }>({
        url: "https://example.com/config",
        followCacheControl: true,
      });
      const store = await source.open();

      await Bun.sleep(30);

      expect(calls).toBeGreaterThan(1);
      expect(store.get()).toEqual({ port: calls });

      await source.close();
    });

    test("no-store/no-cache fetches again immediately", async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return jsonResponse(JSON.stringify({ port: calls }), { cacheControl: "no-store" });
      }) as unknown as typeof fetch;

      const source = fetchSource<{ port: number }>({
        url: "https://example.com/config",
        followCacheControl: true,
      });
      const store = await source.open();

      await Bun.sleep(20);

      expect(calls).toBeGreaterThan(1);
      expect(store.get()).toEqual({ port: calls });

      await source.close();
    });

    test("falls back to pollingInterval for a round without a usable Cache-Control header", async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return jsonResponse(JSON.stringify({ port: calls }));
      }) as unknown as typeof fetch;

      const source = fetchSource<{ port: number }>({
        url: "https://example.com/config",
        pollingInterval: 5,
        followCacheControl: true,
      });
      const store = await source.open();

      await Bun.sleep(30);

      expect(calls).toBeGreaterThan(1);
      expect(store.get()).toEqual({ port: calls });

      await source.close();
    });

    test("stops polling after a round with no usable header when pollingInterval is false", async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return jsonResponse(JSON.stringify({ port: calls }));
      }) as unknown as typeof fetch;

      const source = fetchSource<{ port: number }>({
        url: "https://example.com/config",
        followCacheControl: true,
      });
      await source.open();
      await Bun.sleep(20);

      expect(calls).toBe(1);
    });
  });

  describe("useConditionalRequests", () => {
    test("on by default: echoes back ETag as If-None-Match without setting the option", async () => {
      let calls = 0;
      const receivedHeaders: Headers[] = [];
      globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
        calls++;
        receivedHeaders.push(new Headers(init?.headers));
        return jsonResponse(JSON.stringify({ port: calls }), { etag: '"v1"' });
      }) as unknown as typeof fetch;

      const source = fetchSource<{ port: number }>({
        url: "https://example.com/config",
        pollingInterval: 5,
      });
      await source.open();
      await Bun.sleep(20);
      await source.close();

      expect(calls).toBeGreaterThan(1);
      expect(receivedHeaders[0]?.has("if-none-match")).toBe(false);
      expect(receivedHeaders[1]?.get("if-none-match")).toBe('"v1"');
    });

    test("useConditionalRequests: false opts out — no If-None-Match/If-Modified-Since is ever sent", async () => {
      let calls = 0;
      const receivedHeaders: Headers[] = [];
      globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
        calls++;
        receivedHeaders.push(new Headers(init?.headers));
        return jsonResponse(JSON.stringify({ port: calls }), { etag: '"v1"' });
      }) as unknown as typeof fetch;

      const source = fetchSource<{ port: number }>({
        url: "https://example.com/config",
        pollingInterval: 5,
        useConditionalRequests: false,
      });
      await source.open();
      await Bun.sleep(20);
      await source.close();

      expect(calls).toBeGreaterThan(1);
      expect(receivedHeaders.every((h) => !h.has("if-none-match"))).toBe(true);
    });

    test("explicitly setting useConditionalRequests: true behaves the same as the default", async () => {
      let calls = 0;
      const receivedHeaders: Headers[] = [];
      globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
        calls++;
        receivedHeaders.push(new Headers(init?.headers));
        return jsonResponse(JSON.stringify({ port: calls }), { etag: '"v1"' });
      }) as unknown as typeof fetch;

      const source = fetchSource<{ port: number }>({
        url: "https://example.com/config",
        pollingInterval: 5,
        useConditionalRequests: true,
      });
      await source.open();
      await Bun.sleep(20);
      await source.close();

      expect(calls).toBeGreaterThan(1);
      expect(receivedHeaders[0]?.has("if-none-match")).toBe(false);
      expect(receivedHeaders[1]?.get("if-none-match")).toBe('"v1"');
    });

    test("echoes back Last-Modified as If-Modified-Since on the next round", async () => {
      let calls = 0;
      const receivedHeaders: Headers[] = [];
      globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
        calls++;
        receivedHeaders.push(new Headers(init?.headers));
        return jsonResponse(JSON.stringify({ port: calls }), { lastModified: "Mon, 01 Jan 2024 00:00:00 GMT" });
      }) as unknown as typeof fetch;

      const source = fetchSource<{ port: number }>({
        url: "https://example.com/config",
        pollingInterval: 5,
        useConditionalRequests: true,
      });
      await source.open();
      await Bun.sleep(20);
      await source.close();

      expect(receivedHeaders[1]?.get("if-modified-since")).toBe("Mon, 01 Jan 2024 00:00:00 GMT");
    });

    test("a 304 response is accepted and leaves the store at its last published value", async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        if (calls === 1) return jsonResponse(JSON.stringify({ port: 1 }), { etag: '"v1"' });
        return jsonResponse("", { status: 304, etag: '"v1"' });
      }) as unknown as typeof fetch;

      const source = fetchSource<{ port: number }>({
        url: "https://example.com/config",
        pollingInterval: 5,
        useConditionalRequests: true,
      });
      const store = await source.open();

      await Bun.sleep(20);
      await source.close();

      expect(calls).toBeGreaterThan(1);
      expect(store.get()).toEqual({ port: 1 });
    });

    test("a fresh 200 after a 304 updates the store and refreshes the stored ETag", async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        if (calls === 1) return jsonResponse(JSON.stringify({ port: 1 }), { etag: '"v1"' });
        if (calls === 2) return jsonResponse("", { status: 304, etag: '"v1"' });
        return jsonResponse(JSON.stringify({ port: 2 }), { etag: '"v2"' });
      }) as unknown as typeof fetch;

      const source = fetchSource<{ port: number }>({
        url: "https://example.com/config",
        pollingInterval: 5,
        useConditionalRequests: true,
      });
      const store = await source.open();

      await Bun.sleep(40);
      await source.close();

      expect(calls).toBeGreaterThanOrEqual(3);
      expect(store.get()).toEqual({ port: 2 });
    });

    test("works together with followCacheControl: a 304's Cache-Control still drives the next delay", async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        if (calls === 1) return jsonResponse(JSON.stringify({ port: 1 }), { etag: '"v1"', cacheControl: "max-age=0.005" });
        return jsonResponse("", { status: 304, etag: '"v1"', cacheControl: "max-age=0.005" });
      }) as unknown as typeof fetch;

      const source = fetchSource<{ port: number }>({
        url: "https://example.com/config",
        followCacheControl: true,
        useConditionalRequests: true,
      });
      const store = await source.open();

      await Bun.sleep(30);
      await source.close();

      expect(calls).toBeGreaterThan(1);
      expect(store.get()).toEqual({ port: 1 });
    });
  });

  describe("reduce", () => {
    test("defaults to a full replace: each fetch overwrites the previous value", async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return jsonResponse(JSON.stringify(calls === 1 ? { port: 3000 } : { host: "x" }));
      }) as unknown as typeof fetch;

      const source = fetchSource<Record<string, unknown>>({
        url: "https://example.com/config",
        pollingInterval: 5,
      });
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000 });

      await Bun.sleep(15);

      expect(store.get()).toEqual({ host: "x" });
      await source.close();
    });

    test("merges each round into the previous value instead of replacing it", async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return jsonResponse(JSON.stringify(calls === 1 ? { port: 3000 } : { host: "x" }));
      }) as unknown as typeof fetch;

      const source = fetchSource<Record<string, unknown>>({
        url: "https://example.com/config",
        pollingInterval: 5,
        reduce: (incoming, previous) => ({ ...(previous ?? {}), ...incoming }),
      });
      const store = await source.open();

      expect(store.get()).toEqual({ port: 3000 });

      await Bun.sleep(15);

      expect(store.get()).toEqual({ port: 3000, host: "x" });
      await source.close();
    });

    test("receives the treePath-selected value, not the raw response", async () => {
      globalThis.fetch = (async () =>
        jsonResponse(JSON.stringify({ containers: { settings: { port: 3000 } } }))) as unknown as typeof fetch;

      let received: unknown;
      const source = fetchSource<{ port: number }>({
        url: "https://example.com/config",
        treePath: ["containers", "settings"],
        reduce: (incoming) => {
          received = incoming;
          return incoming;
        },
      });
      await source.open();

      expect(received).toEqual({ port: 3000 });
    });
  });
});
