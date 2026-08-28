import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { fetchSource } from "./fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: string, init: { status?: number; contentType?: string } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": init.contentType ?? "application/json" },
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

  test("retries on a non-ok response, then logs and leaves the store empty when exhausted", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse("", { status: 500 });
    }) as unknown as typeof fetch;

    const source = fetchSource({ url: "https://example.com/config", attempts: 2 });
    const store = await source.open();

    expect(calls).toBe(2);
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
});
