import { afterEach, describe, expect, test } from "bun:test";
import { load } from "./configs.ts";
import { numeric, string } from "./config-descriptor.ts";
import { literalSource } from "./sources/literal.ts";

describe("load()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete (process.env as Record<string, string | undefined>)[key];
    }
    Object.assign(process.env, originalEnv);
  });

  test("with no options at all, reads straight from process.env", async () => {
    process.env.PORT = "8080";

    const cfg = await load({ port: numeric({ key: "PORT" }) });

    expect(cfg.port.get()).toBe(8080);
  });

  test("with options but no sources, still defaults to envSource()", async () => {
    process.env.HOST = "example.com";

    const cfg = await load({ host: string({ key: "HOST" }) }, {});

    expect(cfg.host.get()).toBe("example.com");
  });

  test("an explicit sources array overrides the envSource() default entirely, not merged with it", async () => {
    process.env.PORT = "9999";

    const cfg = await load(
      { port: numeric({ key: "PORT", default: 0 }) },
      { sources: [literalSource({ PORT: "3000" })] },
    );

    // process.env.PORT is never consulted — only the explicit literalSource.
    expect(cfg.port.get()).toBe(3000);
  });

  test("an explicit empty sources array resolves every field to its default, not process.env", async () => {
    process.env.PORT = "9999";

    const cfg = await load({ port: numeric({ key: "PORT", default: 1234 }) }, { sources: [] });

    expect(cfg.port.get()).toBe(1234);
  });

  test("resolves synchronously to each field's default before process.env is read", () => {
    process.env.PORT = "8080";

    const cfg = load({ port: numeric({ key: "PORT", default: 0 }) });

    expect(cfg.port.get()).toBe(0);
  });

  test("behaves exactly like create() once sources are given explicitly", async () => {
    const cfg = await load(
      { promoService: numeric({ default: 0 }) },
      { sources: [literalSource({ promoService: 5 })] },
    );

    expect(cfg.promoService.get()).toBe(5);
  });
});
