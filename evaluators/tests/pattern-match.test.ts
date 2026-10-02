import { evaluatePredicate, predicateSchema } from "../src/index";
import {
  describeMatchExpectation,
  MATCH_PATH_PATTERN,
  MAX_MATCH_PATH_CHARS,
  matchBoundsError,
  matchPathError,
  matchPathFromKey,
  parseMatchPath,
} from "../src/predicates/pattern-match";

describe("parseMatchPath — a one-key RFC 6901 pointer", () => {
  it("reads the key after the slash", () => {
    expect(parseMatchPath("/elements")).toEqual({ ok: true, key: "elements" });
  });

  it("decodes ~1 to / and ~0 to ~", () => {
    expect(parseMatchPath("/a~1b")).toEqual({ ok: true, key: "a/b" });
    expect(parseMatchPath("/a~0b")).toEqual({ ok: true, key: "a~b" });
    expect(parseMatchPath("/~0~1")).toEqual({ ok: true, key: "~/" });
  });

  it("decodes ~1 before ~0, so ~01 is the two characters ~1", () => {
    // RFC 6901 §4: decoding ~0 first would turn "~01" into "~1" and then
    // into "/" — a key the author never wrote.
    expect(parseMatchPath("/~01")).toEqual({ ok: true, key: "~1" });
  });

  it("keeps a key that only looks like an index", () => {
    expect(parseMatchPath("/0")).toEqual({ ok: true, key: "0" });
  });

  it.each([
    ["", "omit path instead"],
    ["/", "2 to 257 characters"],
    [`/${"k".repeat(MAX_MATCH_PATH_CHARS)}`, "2 to 257 characters"],
    ["elements", 'starts with "/"'],
    ["/a/b", "exactly one top-level key"],
    ["/a/", "exactly one top-level key"],
    ["/a~2", "invalid escape"],
    ["/a~", "invalid escape"],
  ])("refuses %j (%s)", (path, message) => {
    const parsed = parseMatchPath(path);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.message).toContain(message);
  });

  it("accepts a path at exactly the length limit", () => {
    const path = `/${"k".repeat(MAX_MATCH_PATH_CHARS - 1)}`;
    expect(path).toHaveLength(MAX_MATCH_PATH_CHARS);
    expect(matchPathError(path)).toBeUndefined();
  });

  it("agrees with MATCH_PATH_PATTERN, which the published schema carries", () => {
    for (const path of [
      "/elements",
      "/a~1b",
      "/~0",
      "/0",
      "/ spaced key ",
      "/é",
      "",
      "/",
      "elements",
      "/a/b",
      "/a~2",
      "/a~",
      "//",
    ]) {
      expect(matchPathError(path) === undefined, path).toBe(
        MATCH_PATH_PATTERN.test(path)
      );
    }
  });

  it("round-trips a key through matchPathFromKey", () => {
    for (const key of ["elements", "a/b", "a~b", "~1", "/", "é"]) {
      const path = matchPathFromKey(key);
      expect(parseMatchPath(path)).toEqual({ ok: true, key });
    }
    expect(matchPathFromKey("a/b~c")).toBe("/a~1b~0c");
  });

  it("is refused by the schema exactly when matchPathError refuses it", () => {
    for (const path of ["/elements", "/a~1b", "", "/", "elements", "/a/b"]) {
      const parsed = predicateSchema.safeParse({
        type: "toolInputMatches",
        toolName: "t",
        patterns: ["a"],
        path,
      });
      expect(parsed.success, path).toBe(matchPathError(path) === undefined);
    }
  });

  it("reads an escaped key from a call's arguments", () => {
    const result = evaluatePredicate(
      { toolCalls: [{ toolName: "t", arguments: { "a/b": "Idea" } }] },
      {
        type: "toolInputMatches",
        toolName: "t",
        patterns: ["Idea"],
        path: "/a~1b",
      }
    );
    expect(result.passed).toBe(true);
  });
});

describe("counting sentences name the unit", () => {
  it.each([
    [{ min: 1, max: undefined }, "call", "at least 1 matching call(s)"],
    [{ min: 0, max: 0 }, "call", "no matching call"],
    [{ min: 2, max: 2 }, "result", "exactly 2 matching result(s)"],
    [{ min: 0, max: 3 }, "result", "at most 3 matching result(s)"],
    [{ min: 1, max: 3 }, "result", "1 to 3 matching results"],
  ] as const)("%j per %s reads %j", (bounds, unit, sentence) => {
    expect(describeMatchExpectation(bounds, unit)).toBe(sentence);
  });

  it("says which unit min 0 / max 0 refers to", () => {
    expect(matchBoundsError(0, undefined, "call")?.message).toContain(
      "no call matches"
    );
    expect(matchBoundsError(0, undefined, "result")?.message).toContain(
      "no result matches"
    );
  });
});
