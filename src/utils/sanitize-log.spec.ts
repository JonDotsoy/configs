import { describe, expect, test } from "bun:test";
import { maskSensitiveArgs, maskSensitiveUrl } from "./sanitize-log.js";

describe("maskSensitiveArgs", () => {
  test("masks a flag's separate value when the flag name looks sensitive", () => {
    expect(maskSensitiveArgs(["foo", "--key", "1234"])).toEqual(["foo", "--key", "****"]);
    expect(maskSensitiveArgs(["foo", "--token", "abcd"])).toEqual(["foo", "--token", "****"]);
    expect(maskSensitiveArgs(["foo", "--password", "hunter2"])).toEqual(["foo", "--password", "****"]);
  });

  test("masks a flag's inline (=) value when the flag name looks sensitive", () => {
    expect(maskSensitiveArgs(["foo", "--key=1234"])).toEqual(["foo", "--key=****"]);
    expect(maskSensitiveArgs(["foo", "--api-key=1234"])).toEqual(["foo", "--api-key=****"]);
  });

  test("masks a header-style argument's value, keeping any scheme prefix", () => {
    expect(maskSensitiveArgs(["curl", "-H", "Authorization: Bearer xxx"])).toEqual([
      "curl",
      "-H",
      "Authorization: Bearer ****",
    ]);
    expect(maskSensitiveArgs(["curl", "-H", "token: xxx"])).toEqual(["curl", "-H", "token: ****"]);
  });

  test("leaves non-sensitive flags/values untouched", () => {
    const args = ["gh", "auth", "token", "--format", "json"];
    // "token" here is a positional subcommand, not a --token flag, so it's left alone
    expect(maskSensitiveArgs(["gh", "--format", "json"])).toEqual(["gh", "--format", "json"]);
    expect(maskSensitiveArgs(args)).toEqual(args);
  });

  test("does not mutate the input array", () => {
    const args = ["foo", "--key", "1234"];
    const masked = maskSensitiveArgs(args);
    expect(args).toEqual(["foo", "--key", "1234"]);
    expect(masked).not.toBe(args);
  });

  test("a sensitive flag with nothing after it is left as just the flag", () => {
    expect(maskSensitiveArgs(["foo", "--key"])).toEqual(["foo", "--key"]);
  });
});

describe("maskSensitiveUrl", () => {
  test("masks a sensitive query parameter's value", () => {
    expect(maskSensitiveUrl("https://example.com/api?token=abcd1234")).toBe("https://example.com/api?token=****");
    expect(maskSensitiveUrl("https://example.com/api?api_key=abcd1234")).toBe(
      "https://example.com/api?api_key=****",
    );
  });

  test("leaves non-sensitive query parameters untouched", () => {
    expect(maskSensitiveUrl("https://example.com/api?page=2&sort=asc")).toBe(
      "https://example.com/api?page=2&sort=asc",
    );
  });

  test("masks a sensitive parameter alongside other, untouched ones", () => {
    expect(maskSensitiveUrl("https://example.com/api?page=2&token=abcd1234")).toBe(
      "https://example.com/api?page=2&token=****",
    );
  });

  test("accepts a URL instance as well as a string", () => {
    expect(maskSensitiveUrl(new URL("https://example.com/api?secret=abcd1234"))).toBe(
      "https://example.com/api?secret=****",
    );
  });

  test("returns an unparseable url as-is instead of throwing", () => {
    expect(maskSensitiveUrl("not a url")).toBe("not a url");
  });
});
