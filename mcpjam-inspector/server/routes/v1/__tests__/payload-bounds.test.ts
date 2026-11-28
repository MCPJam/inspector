import { describe, expect, it } from "vitest";
import { createSecretScrubber } from "../../../utils/secrets/secret-scrubber.js";
import { boundJson, underField } from "../payload-bounds.js";

/**
 * `boundJson` shortens a payload INSIDE the value, so the result is still the
 * JSON it was. The old bound sliced the serialized text, which handed back a
 * broken JSON string with `isError` and everything after the cut buried in it.
 */

const LENGTH_MARKER = /…\[\+(\d+) chars\]$/;
const ITEMS_MARKER = /^…\[\+(\d+) items\]$/;

const jsonLength = (value: unknown) => JSON.stringify(value).length;

/** The characters a shortened string kept, and the count its marker claims. */
function splitShortened(text: unknown): { kept: string; removed: number } {
  const match = typeof text === "string" ? LENGTH_MARKER.exec(text) : null;
  if (!match || typeof text !== "string") {
    throw new Error(`not a shortened string: ${String(text).slice(0, 80)}`);
  }
  return {
    kept: text.slice(0, match.index),
    removed: Number(match[1]),
  };
}

describe("boundJson", () => {
  it("returns a value that fits whole, with nothing listed", () => {
    const value = { city: "SF", temps: [1, 2, 3], nested: { ok: true } };
    expect(boundJson(value, 1_000)).toEqual({
      value,
      truncated: false,
      truncatedFields: [],
    });
  });

  it("comes back undefined for undefined", () => {
    expect(boundJson(undefined, 1_000)).toEqual({
      value: undefined,
      truncated: false,
      truncatedFields: [],
    });
  });

  it("keeps the input's JSON type: an object stays an object", () => {
    const long = "x".repeat(5_000);
    expect(boundJson({ text: long, isError: true }, 1_000).value).toEqual({
      text: expect.stringMatching(LENGTH_MARKER),
      isError: true,
    });
    expect(boundJson([long, long], 1_000).value).toEqual([
      expect.stringMatching(LENGTH_MARKER),
      expect.stringMatching(LENGTH_MARKER),
    ]);
    expect(boundJson(long, 1_000).value).toEqual(
      expect.stringMatching(LENGTH_MARKER),
    );
  });

  it("ends a shortened string in …[+N chars], N being what it removed", () => {
    const text = "abcdefghij".repeat(1_000);
    const result = boundJson({ text, ok: 1 }, 2_000);

    const shortened = (result.value as { text: string }).text;
    const { kept, removed } = splitShortened(shortened);
    expect(text.startsWith(kept)).toBe(true);
    expect(kept.length + removed).toBe(text.length);
    expect(result.truncated).toBe(true);
    expect(result.truncatedFields).toEqual([
      { path: "text", reason: "length", originalLength: 10_000 },
    ]);
    expect(jsonLength(result.value)).toBeLessThanOrEqual(2_000);
    // The cap is the LARGEST that fits, not merely one that does.
    expect(jsonLength(result.value)).toBeGreaterThan(1_990);
  });

  it("shortens many strings to one cap and lists every one", () => {
    const items = Array.from({ length: 40 }, (_, index) => ({
      id: `n${index}`,
      body: "b".repeat(500),
    }));
    const result = boundJson({ items }, 8_000);

    const bounded = (result.value as { items: typeof items }).items;
    expect(bounded).toHaveLength(40);
    const kept = bounded.map((item) => splitShortened(item.body).kept.length);
    expect(new Set(kept).size).toBe(1);
    // Strings no longer than the cap are left alone.
    expect(bounded.map((item) => item.id)).toEqual(items.map((i) => i.id));
    expect(result.truncatedFields).toEqual(
      items.map((_, index) => ({
        path: `items[${index}].body`,
        reason: "length",
        originalLength: 500,
      })),
    );
    expect(jsonLength(result.value)).toBeLessThanOrEqual(8_000);
  });

  it("keeps the first items of a long array, ending in …[+N items]", () => {
    const values = Array.from({ length: 20_000 }, (_, index) => index);
    const result = boundJson({ values }, 2_000);

    const bounded = (result.value as { values: unknown[] }).values;
    const marker = ITEMS_MARKER.exec(String(bounded.at(-1)));
    expect(marker).not.toBeNull();
    const keptItems = bounded.slice(0, -1);
    expect(keptItems).toEqual(values.slice(0, keptItems.length));
    expect(keptItems.length + Number(marker?.[1])).toBe(values.length);
    expect(result.truncatedFields).toEqual([
      { path: "values", reason: "items", originalLength: 20_000 },
    ]);
    expect(jsonLength(result.value)).toBeLessThanOrEqual(2_000);
  });

  it("keeps whole short strings rather than cutting each to a stub", () => {
    // Cutting all of these to fit would leave each a few characters and a
    // marker longer than what it kept.
    const names = Array.from({ length: 1_000 }, (_, i) =>
      `name-${i}-`.padEnd(30, "x"),
    );
    const result = boundJson({ names }, 16_000);

    const bounded = (result.value as { names: string[] }).names;
    expect(bounded.slice(0, -1)).toEqual(names.slice(0, bounded.length - 1));
    expect(bounded.at(-1)).toMatch(ITEMS_MARKER);
    expect(result.truncatedFields).toEqual([
      { path: "names", reason: "items", originalLength: 1_000 },
    ]);
    expect(jsonLength(result.value)).toBeLessThanOrEqual(16_000);
  });

  it("keeps an array's first item when that item holds the long string", () => {
    // A tool result's usual shape: the text block, and the same data again as
    // structured content. Emptying both arrays would fit, and say nothing.
    const rows = Array.from({ length: 5_000 }, (_, id) => ({ id }));
    const result = boundJson(
      { content: [{ type: "text", text: "t".repeat(50_000) }], rows },
      4_000,
    );

    expect(result.value).toEqual({
      content: [{ type: "text", text: expect.stringMatching(LENGTH_MARKER) }],
      rows: expect.arrayContaining([
        { id: 0 },
        expect.stringMatching(ITEMS_MARKER),
      ]),
    });
    expect(result.truncatedFields).toEqual([
      { path: "content[0].text", reason: "length", originalLength: 50_000 },
      { path: "rows", reason: "items", originalLength: 5_000 },
    ]);
    expect(jsonLength(result.value)).toBeLessThanOrEqual(4_000);
  });

  it("cuts strings and arrays together when neither alone can fit", () => {
    const rows = Array.from({ length: 5_000 }, (_, index) => index);
    const result = boundJson({ summary: "s".repeat(50_000), rows }, 4_000);

    const bounded = result.value as { summary: string; rows: unknown[] };
    expect(result.truncatedFields).toEqual([
      { path: "summary", reason: "length", originalLength: 50_000 },
      { path: "rows", reason: "items", originalLength: 5_000 },
    ]);
    // Neither side is starved: the text keeps about half the room it would
    // have alone, and the rows fill the rest.
    expect(splitShortened(bounded.summary).kept.length).toBeGreaterThan(1_500);
    expect(bounded.rows.length).toBeGreaterThan(200);
    expect(jsonLength(result.value)).toBeLessThanOrEqual(4_000);
  });

  it("keeps the first entries of an object whose keys alone are too long", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 2_000 }, (_, index) => [`key${index}`, index]),
    );
    const result = boundJson(wide, 1_000);

    const keys = Object.keys(result.value as object);
    expect(keys.length).toBeGreaterThan(50);
    expect(keys).toEqual(Object.keys(wide).slice(0, keys.length));
    expect(result.truncatedFields).toEqual([
      { path: "", reason: "items", originalLength: 2_000 },
    ]);
    expect(jsonLength(result.value)).toBeLessThanOrEqual(1_000);
  });

  it("flags a depth cut as truncation, even on a small value", () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 10; i++) deep = { n: deep };
    const result = boundJson(deep, 1_000);

    expect(result.truncated).toBe(true);
    expect(result.truncatedFields).toEqual([
      { path: "n.n.n.n.n.n.n.n", reason: "depth" },
    ]);
    expect(JSON.stringify(result.value)).toContain('"[truncated: max depth]"');
  });

  it("cuts a circular reference where it loops back, as a depth cut", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(boundJson(cyclic, 1_000)).toEqual({
      value: { name: "loop", self: "[truncated: circular reference]" },
      truncated: true,
      truncatedFields: [{ path: "self", reason: "depth" }],
    });
  });

  it("quotes keys that are not identifiers and indexes arrays in paths", () => {
    const result = boundJson({ "a b": ["short", "y".repeat(5_000)] }, 1_000);
    expect(result.truncatedFields).toEqual([
      { path: '["a b"][1]', reason: "length", originalLength: 5_000 },
    ]);
    expect(underField("output", result.truncatedFields)).toEqual([
      { path: 'output["a b"][1]', reason: "length", originalLength: 5_000 },
    ]);
    const root = boundJson("x".repeat(5_000), 1_000).truncatedFields;
    expect(underField("content", root)).toEqual([
      { path: "content", reason: "length", originalLength: 5_000 },
    ]);
  });

  it("never keeps half of a surrogate pair", () => {
    const result = boundJson("😀".repeat(3_000), 1_001);
    const { kept, removed } = splitShortened(result.value);
    expect(kept.length % 2).toBe(0);
    expect(kept.length + removed).toBe(6_000);
    expect(JSON.stringify(result.value)).not.toMatch(/\\ud8/);
  });

  it("replaces secrets before cutting, so no fragment of one survives", () => {
    // A token as long as a JWT, and filler that forces a cap well below its
    // length: cutting before scrubbing would keep the token's first
    // characters, which no needle can match.
    const value = `sk_live_${"a".repeat(392)}`;
    const scrubber = createSecretScrubber([{ name: "STRIPE_API_KEY", value }])!;
    const payload = {
      filler: Array.from({ length: 5 }, () => "x".repeat(5_000)),
      key: value,
      // A key holding the token, with a value long enough to be cut, so its
      // path is listed too.
      [value]: "z".repeat(1_000),
    };
    const result = boundJson(payload, 1_500, scrubber);

    const cut = splitShortened(
      (result.value as { filler: string[] }).filler[0],
    );
    expect(cut.kept.length).toBeLessThan(value.length);
    // The whole result, paths included.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(value.slice(0, 12));
    expect(result.value).toMatchObject({ key: "[secret:STRIPE_API_KEY]" });
    expect(result.truncatedFields).toContainEqual({
      path: '["[secret:STRIPE_API_KEY]"]',
      reason: "length",
      originalLength: 1_000,
    });
    expect(jsonLength(result.value)).toBeLessThanOrEqual(1_500);
  });
});
