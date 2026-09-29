import { describe, expect, test } from "bun:test";
import { Properties } from "./properties";

describe("Properties.parse", () => {
  test("parses simple key=value pairs", () => {
    expect(Properties.parse("port=3000\nhost=localhost\n")).toEqual({
      port: "3000",
      host: "localhost",
    });
  });

  test("nests dotted keys into a tree, matching the issue's example", () => {
    expect(
      Properties.parse('game.initial-score=30\nplayers.default-name="default"\n'),
    ).toEqual({
      game: { "initial-score": "30" },
      players: { "default-name": '"default"' },
    });
  });

  test("merges dotted keys sharing a common prefix into the same nested object", () => {
    expect(Properties.parse("server.port=8080\nserver.host=localhost\n")).toEqual({
      server: { port: "8080", host: "localhost" },
    });
  });

  describe("separators", () => {
    test("accepts a colon separator", () => {
      expect(Properties.parse("port:3000\n")).toEqual({ port: "3000" });
    });

    test("accepts a plain whitespace separator", () => {
      expect(Properties.parse("port 3000\n")).toEqual({ port: "3000" });
    });

    test("ignores whitespace surrounding an = separator", () => {
      expect(Properties.parse("port  =  3000\n")).toEqual({ port: "3000" });
    });

    test("ignores whitespace surrounding a : separator", () => {
      expect(Properties.parse("port  :  3000\n")).toEqual({ port: "3000" });
    });

    test("a key with no separator gets an empty string value", () => {
      expect(Properties.parse("standalone\n")).toEqual({ standalone: "" });
    });
  });

  describe("comments", () => {
    test("skips whole-line # comments", () => {
      expect(Properties.parse("# a comment\nport=3000\n")).toEqual({ port: "3000" });
    });

    test("skips whole-line ! comments", () => {
      expect(Properties.parse("! another style of comment\nport=3000\n")).toEqual({
        port: "3000",
      });
    });

    test("skips blank lines", () => {
      expect(Properties.parse("\nport=3000\n\n\nhost=localhost\n")).toEqual({
        port: "3000",
        host: "localhost",
      });
    });

    test("a comment marker after leading whitespace is still a comment", () => {
      expect(Properties.parse("   # indented comment\nport=3000\n")).toEqual({ port: "3000" });
    });

    test("an escaped comment marker at the start of a key is not a comment", () => {
      expect(Properties.parse("\\#weird=1\n\\!other=2\n")).toEqual({ "#weird": "1", "!other": "2" });
    });
  });

  describe("escapes", () => {
    test("decodes \\t \\n \\r \\f in values", () => {
      expect(Properties.parse("value=a\\tb\\nc\\rd\\fe\n")).toEqual({ value: "a\tb\nc\rd\fe" });
    });

    test("decodes a \\uXXXX unicode escape", () => {
      expect(Properties.parse("smiley=\\u263A\n")).toEqual({ smiley: "\u263A" });
    });

    test("leaves an incomplete \\uXXXX escape as a literal u, dropping only the backslash", () => {
      expect(Properties.parse("bad=\\u12\n")).toEqual({ bad: "u12" });
    });

    test("an escaped = or : inside a key is not treated as the separator", () => {
      expect(Properties.parse("weird\\=key=value\n")).toEqual({ "weird=key": "value" });
      expect(Properties.parse("weird\\:key=value\n")).toEqual({ "weird:key": "value" });
    });

    test("an escaped space inside a key is not treated as the separator", () => {
      expect(Properties.parse("weird\\ key=value\n")).toEqual({ "weird key": "value" });
    });

    test("decodes \\\\ to a single backslash", () => {
      expect(Properties.parse("path=C:\\\\\\\\Users\n")).toEqual({ path: "C:\\\\Users" });
    });

    test("a backslash before an unrecognized character resolves to that character literally", () => {
      expect(Properties.parse("value=ran\\dom\n")).toEqual({ value: "random" });
    });
  });

  describe("line continuation", () => {
    test("a trailing backslash continues the value onto the next line", () => {
      expect(Properties.parse("welcome=Welcome to \\\n          Wikipedia!\n")).toEqual({
        welcome: "Welcome to Wikipedia!",
      });
    });

    test("strips leading whitespace from the continuation line only, not the value's own spacing", () => {
      expect(Properties.parse("a=one \\\n  two\n")).toEqual({ a: "one two" });
    });

    test("a trailing escaped backslash (\\\\) does not continue the line", () => {
      expect(Properties.parse("path=C:\\\\\\\\\nnext=1\n")).toEqual({
        path: "C:\\\\",
        next: "1",
      });
    });

    test("continues across more than one line", () => {
      expect(Properties.parse("a=one \\\ntwo \\\nthree\n")).toEqual({ a: "one two three" });
    });
  });

  describe("edge cases", () => {
    test("an empty document parses to an empty object", () => {
      expect(Properties.parse("")).toEqual({});
    });

    test("tolerates CRLF line endings", () => {
      expect(Properties.parse("port=3000\r\nhost=localhost\r\n")).toEqual({
        port: "3000",
        host: "localhost",
      });
    });

    test("a later duplicate key overwrites an earlier one", () => {
      expect(Properties.parse("port=3000\nport=4000\n")).toEqual({ port: "4000" });
    });

    test("a leaf value and a nested object can't coexist at the same dotted prefix — the later line wins", () => {
      expect(Properties.parse("game=leaf\ngame.initial-score=30\n")).toEqual({
        game: { "initial-score": "30" },
      });
    });
  });
});
