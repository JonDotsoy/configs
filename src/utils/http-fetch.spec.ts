import { afterEach, describe, expect, test } from "bun:test";
import { httpFetch } from "./http-fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: string, init: { status?: number } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("httpFetch", () => {
  test("fetches and parses a JSON response by default", async () => {
    let receivedUrl: string | URL | undefined;
    let receivedInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      receivedUrl = url;
      receivedInit = init;
      return jsonResponse(JSON.stringify({ port: 3000 }));
    }) as unknown as typeof fetch;

    const result = await httpFetch<{ port: number }>({
      url: "https://example.com/config",
      method: "POST",
      headers: { authorization: "Bearer token" },
    });

    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ port: 3000 });
    expect(receivedUrl).toBe("https://example.com/config");
    expect(receivedInit?.method).toBe("POST");
    expect(receivedInit?.headers).toEqual({ authorization: "Bearer token" });
  });

  test("retries network errors up to `attempts` times before succeeding", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls < 3) throw new Error("network down");
      return jsonResponse(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;

    const result = await httpFetch({ url: "https://example.com/config", attempts: 3 });

    expect(calls).toBe(3);
    expect(result.body).toEqual({ ok: true });
  });

  test("exhausted network-error attempts throws an AttemptsExhaustedError wrapping the last error", async () => {
    let calls = 0;
    const networkError = new Error("network down");
    globalThis.fetch = (async () => {
      calls++;
      throw networkError;
    }) as unknown as typeof fetch;

    await expect(httpFetch({ url: "https://example.com/config", attempts: 2 })).rejects.toThrow(
      /failed after 2 attempt\(s\).*network down/,
    );
    expect(calls).toBe(2);

    try {
      await httpFetch({ url: "https://example.com/config", attempts: 2 });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("AttemptsExhaustedError");
      expect((error as Error & { cause?: unknown }).cause).toBe(networkError);
    }
  });

  test("a rejected status throws immediately, without retrying", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse(JSON.stringify({ message: "boom" }), { status: 500 });
    }) as unknown as typeof fetch;

    await expect(httpFetch({ url: "https://example.com/config", attempts: 3 })).rejects.toThrow(/500/);
    expect(calls).toBe(1);
  });

  test("a custom bodyParser is used instead of the default JSON parsing", async () => {
    globalThis.fetch = (async () => jsonResponse(JSON.stringify({ port: 3000 }))) as unknown as typeof fetch;

    const result = await httpFetch({
      url: "https://example.com/config",
      bodyParser: async (res) => res.text(),
    });

    expect(result.body).toBe(JSON.stringify({ port: 3000 }));
  });

  test("bodyParser throwing on an accepted response is not retried and rejects", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse(JSON.stringify({ port: 3000 }));
    }) as unknown as typeof fetch;

    await expect(
      httpFetch({
        url: "https://example.com/config",
        attempts: 3,
        bodyParser: async () => {
          throw new Error("parse failed");
        },
      }),
    ).rejects.toThrow("parse failed");
    expect(calls).toBe(1);
  });

  test("default acceptStatus treats 2xx as accepted and anything else as rejected", async () => {
    globalThis.fetch = (async () => jsonResponse("{}", { status: 404 })) as unknown as typeof fetch;

    await expect(httpFetch({ url: "https://example.com/config" })).rejects.toThrow(/404/);
  });

  test("passes `body` through to fetch as-is", async () => {
    let receivedInit: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      receivedInit = init;
      return jsonResponse(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;

    await httpFetch({
      url: "https://example.com/config",
      method: "POST",
      body: JSON.stringify({ name: "port" }),
    });

    expect(receivedInit?.body).toBe(JSON.stringify({ name: "port" }));
  });

  test("passes `signal` through to fetch", async () => {
    let receivedInit: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      receivedInit = init;
      return jsonResponse(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    await httpFetch({ url: "https://example.com/config", signal: controller.signal });

    expect(receivedInit?.signal).toBe(controller.signal);
  });

  test("an abort error is not retried, even with `attempts` set", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    await expect(
      httpFetch({ url: "https://example.com/config", attempts: 3, signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
    expect(calls).toBe(1);
  });

  test("passes `mode`, `cache`, and `redirect` through to fetch as-is", async () => {
    let receivedInit: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      receivedInit = init;
      return jsonResponse(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;

    await httpFetch({
      url: "https://example.com/config",
      mode: "cors",
      cache: "no-store",
      redirect: "manual",
    });

    expect(receivedInit?.mode).toBe("cors");
    expect(receivedInit?.cache).toBe("no-store");
    expect(receivedInit?.redirect).toBe("manual");
  });

  test("`credentials.basic` sends a Basic Authorization header up front", async () => {
    let receivedInit: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      receivedInit = init;
      return jsonResponse(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;

    await httpFetch({
      url: "https://example.com/config",
      credentials: { basic: { username: "alice", password: "wonderland" } },
    });

    const headers = new Headers(receivedInit?.headers);
    expect(headers.get("authorization")).toBe(`Basic ${btoa("alice:wonderland")}`);
  });

  test("`credentials.bearer` sends a Bearer Authorization header up front", async () => {
    let receivedInit: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      receivedInit = init;
      return jsonResponse(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;

    await httpFetch({
      url: "https://example.com/config",
      credentials: { bearer: { token: "abc123" } },
    });

    const headers = new Headers(receivedInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer abc123");
  });

  test("a custom acceptStatus can accept a status the default would reject, without retrying", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse(JSON.stringify({ found: false }), { status: 404 });
    }) as unknown as typeof fetch;

    const result = await httpFetch<{ found: boolean }>({
      url: "https://example.com/config",
      attempts: 3,
      acceptStatus: (statusCode) => statusCode === 404,
    });

    expect(calls).toBe(1);
    expect(result.body).toEqual({ found: false });
  });
});
