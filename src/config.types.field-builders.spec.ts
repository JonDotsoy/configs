import { describe, expect, expectTypeOf, test } from "bun:test";
import { boolean, create, numeric, string } from "./configs.js";
import { envSource, mapKey } from "./sources/env.js";
import { fetchSource } from "./sources/fetch.js";
import type { ReadOnlyStore } from "./config.types.js";

describe("string/numeric/boolean field builders", () => {
  test("string() builds a { type: \"string\" } field schema", () => {
    expect(string()).toEqual({ type: "string" });
    expect(string({ summary: "bind host", default: "localhost" })).toEqual({
      type: "string",
      summary: "bind host",
      default: "localhost",
    });
  });

  test("numeric() builds a { type: \"number\" } field schema", () => {
    expect(numeric()).toEqual({ type: "number" });
    expect(numeric({ summary: "HTTP port", default: 3000 })).toEqual({
      type: "number",
      summary: "HTTP port",
      default: 3000,
    });
  });

  test("boolean() builds a { type: \"boolean\" } field schema", () => {
    expect(boolean()).toEqual({ type: "boolean" });
    expect(boolean({ summary: "enable the promo service", default: false })).toEqual({
      type: "boolean",
      summary: "enable the promo service",
      default: false,
    });
  });

  test("string() carries a pattern through unchanged", () => {
    const pattern = /^[\w.-]+$/;
    expect(string({ pattern })).toEqual({ type: "string", pattern });
  });

  test("resolve the same as their equivalent object-literal field schemas", async () => {
    const viaBuilders = await create(
      {
        port: numeric({ default: 3000 }),
        host: string({ default: "localhost" }),
        enabled: boolean({ default: false }),
      },
      { sources: [] },
    );
    const viaLiterals = await create(
      {
        port: { type: "number", default: 3000 },
        host: { type: "string", default: "localhost" },
        enabled: { type: "boolean", default: false },
      },
      { sources: [] },
    );

    expect(viaBuilders.get()).toEqual(viaLiterals.get());
  });
});

describe("README example: create() + string/numeric/boolean + envSource + fetchSource", () => {
  test("server group resolves numeric/string fields from a snake_case-mapped envSource", async () => {
    const serverConfigs = await create(
      {
        port: numeric({ summary: "HTTP port", default: 3000 }),
        host: string({ summary: "bind host", default: "localhost" }),
      },
      {
        sources: [
          envSource({
            env: { PORT: "4000", HOST: "example.com" },
            mapKey: mapKey.snakeCase(),
          }),
        ],
      },
    );

    expect(serverConfigs.get()).toEqual({ port: 4000, host: "example.com" });
    expect(serverConfigs.port.get()).toBe(4000);
    expect(serverConfigs.host.get()).toBe("example.com");

    expectTypeOf(serverConfigs.port).toEqualTypeOf<ReadOnlyStore<number>>();
    expectTypeOf(serverConfigs.host).toEqualTypeOf<ReadOnlyStore<string>>();
  });

  test("server group falls back to defaults when the mapped env vars are absent", async () => {
    const serverConfigs = await create(
      {
        port: numeric({ summary: "HTTP port", default: 3000 }),
        host: string({ summary: "bind host", default: "localhost" }),
      },
      { sources: [envSource({ env: {}, mapKey: mapKey.snakeCase() })] },
    );

    expect(serverConfigs.get()).toEqual({ port: 3000, host: "localhost" });
  });

  test("features group resolves a boolean field from a fetchSource", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ promoService: true }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    try {
      const featuresConfigs = await create(
        {
          promoService: boolean({ summary: "enable the promo service", default: false }),
        },
        {
          sources: [fetchSource({ url: "https://example.com/features", pollingInterval: 30_000 })],
        },
      );

      expect(featuresConfigs.get()).toEqual({ promoService: true });
      expect(featuresConfigs.promoService.get()).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("full example: nested server + features groups resolve together", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ promoService: true }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    try {
      const cfg = await create({
        server: create(
          {
            port: numeric({ summary: "HTTP port", default: 3000 }),
            host: string({ summary: "bind host", default: "localhost" }),
          },
          {
            sources: [
              envSource({
                env: { PORT: "3000", HOST: "localhost" },
                mapKey: mapKey.snakeCase(),
              }),
            ],
          },
        ),
        features: create(
          {
            promoService: boolean({ summary: "enable the promo service", default: false }),
          },
          {
            sources: [fetchSource({ url: "https://example.com/features", pollingInterval: 30_000 })],
          },
        ),
      });

      expect(cfg.get()).toEqual({
        server: { port: 3000, host: "localhost" },
        features: { promoService: true },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
