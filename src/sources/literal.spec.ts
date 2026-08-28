import { describe, expect, test } from "bun:test";
import { configs } from "../configs";
import { literalSource } from "./literal";

describe("literalSource", () => {
  test("publishes the given value immediately", async () => {
    const source = literalSource({ port: 3000 });
    const store = await source.open();

    expect(store.get()).toEqual({ port: 3000 });
  });

  test("closes itself right after publishing", async () => {
    const source = literalSource({ port: 3000 });
    await source.open();

    await expect(source.close()).resolves.toBeUndefined();
  });

  test("wires into configs.create as a source", async () => {
    const cfg = await configs.create(
      { port: { type: "number", required: true } },
      { sources: [literalSource({ port: 3000 })] },
    );

    expect(cfg.port.get()).toBe(3000);
  });

  test("acts as a static fallback behind an earlier source that's missing a field", async () => {
    const cfg = await configs.create(
      {
        port: { type: "number", required: true },
        host: { type: "string", required: true },
      },
      {
        sources: [literalSource({ port: 8080 }), literalSource({ port: 3000, host: "localhost" })],
      },
    );

    expect(cfg.port.get()).toBe(8080);
    expect(cfg.host.get()).toBe("localhost");
  });
});
