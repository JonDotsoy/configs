import { describe, expect, test } from "bun:test";
import { DotEnv } from "./dotenv";

describe("DotEnv.parse", () => {
  describe("key=value spacing", () => {
    test.each([
      ["FOO = true", "spaces around ="],
      ["FOO = true # comment", "spaces around =, with a trailing comment"],
      ["FOO= true", "space only after ="],
      ["FOO=true", "no spaces"],
      ['FOO="true"', "double-quoted value"],
    ])("%s (%s) parses to { FOO: \"true\" }", (line) => {
      expect(DotEnv.parse(line)).toEqual({ FOO: "true" });
    });
  });

  test("parses multiple KEY=VALUE lines into a flat string map", () => {
    expect(DotEnv.parse("PORT=3000\nHOST=localhost\n")).toEqual({
      PORT: "3000",
      HOST: "localhost",
    });
  });

  test("skips blank lines", () => {
    expect(DotEnv.parse("\nPORT=3000\n\n\nHOST=localhost\n")).toEqual({
      PORT: "3000",
      HOST: "localhost",
    });
  });

  test("skips a line that's entirely a comment", () => {
    expect(DotEnv.parse("# a comment\nPORT=3000\n# another comment\n")).toEqual({ PORT: "3000" });
  });

  test("skips a line with no '='", () => {
    expect(DotEnv.parse("not a valid line\nPORT=3000\n")).toEqual({ PORT: "3000" });
  });

  test("a value can itself contain '='", () => {
    expect(DotEnv.parse("URL=https://example.com?a=1&b=2")).toEqual({
      URL: "https://example.com?a=1&b=2",
    });
  });

  test("single-quoted value", () => {
    expect(DotEnv.parse("FOO='true'")).toEqual({ FOO: "true" });
  });

  test("a backslash-escaped quote inside a quoted value doesn't end it early, but the backslash itself is kept literally (matches motdotla/dotenv)", () => {
    expect(DotEnv.parse("OTHER='it\\'s fine'")).toEqual({ OTHER: "it\\'s fine" });
  });

  test("a quoted value can contain a literal '#' without it being treated as a comment", () => {
    expect(DotEnv.parse('FOO="not #a comment"')).toEqual({ FOO: "not #a comment" });
  });

  test("a '#' with no preceding whitespace is not treated as a comment", () => {
    expect(DotEnv.parse("FOO=abc#def")).toEqual({ FOO: "abc#def" });
  });

  test("an empty unquoted value", () => {
    expect(DotEnv.parse("FOO=")).toEqual({ FOO: "" });
  });

  test("a later key overwrites an earlier one with the same name", () => {
    expect(DotEnv.parse("FOO=1\nFOO=2\n")).toEqual({ FOO: "2" });
  });

  describe("backtick-quoted values", () => {
    test("strips the surrounding backticks", () => {
      expect(DotEnv.parse("FOO=`true`")).toEqual({ FOO: "true" });
    });

    test("keeps quote characters from other quoting styles literal inside", () => {
      expect(DotEnv.parse("JSON=`{\"foo\": \"bar\"}`")).toEqual({ JSON: '{"foo": "bar"}' });
    });
  });

  describe("\\n/\\r expansion — double-quoted values only", () => {
    test("expands \\n to a real newline inside double quotes", () => {
      expect(DotEnv.parse('FOO="line1\\nline2"')).toEqual({ FOO: "line1\nline2" });
    });

    test("expands \\r to a real carriage return inside double quotes", () => {
      expect(DotEnv.parse('FOO="a\\rb"')).toEqual({ FOO: "a\rb" });
    });

    test("does NOT expand \\n inside single quotes", () => {
      expect(DotEnv.parse("FOO='line1\\nline2'")).toEqual({ FOO: "line1\\nline2" });
    });

    test("does NOT expand \\n inside backticks", () => {
      expect(DotEnv.parse("FOO=`line1\\nline2`")).toEqual({ FOO: "line1\\nline2" });
    });
  });

  test("preserves leading/trailing whitespace inside a quoted value", () => {
    expect(DotEnv.parse('FOO=" some value "')).toEqual({ FOO: " some value " });
  });
});
