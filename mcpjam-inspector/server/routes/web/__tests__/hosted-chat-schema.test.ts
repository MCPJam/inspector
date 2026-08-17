import { describe, expect, it } from "vitest";
import { hostedChatSchema } from "../auth";
import { parseWithSchema } from "../errors";

/**
 * `expectedVersion` is the resumed thread's optimistic-concurrency baseline. It
 * is validated HERE, at the request boundary, rather than forwarded raw: a
 * malformed value used to travel all the way to the ingest action's own
 * validator, surfacing as an opaque 500 instead of a 400 naming the field.
 *
 * The schema is `.passthrough()`, so an unrecognized key is carried through
 * untouched — which is exactly why a declared key needs a real test: without
 * one, deleting the declaration would look like it changed nothing.
 */
describe("hostedChatSchema expectedVersion", () => {
  const base = {
    projectId: "project-1",
    selectedServerIds: ["server-1"],
  };

  const parse = (expectedVersion: unknown) =>
    parseWithSchema(hostedChatSchema, { ...base, expectedVersion });

  it("accepts an omitted expectedVersion — a fresh thread has no baseline", () => {
    expect(
      parseWithSchema(hostedChatSchema, base).expectedVersion
    ).toBeUndefined();
  });

  it("accepts zero and positive integers", () => {
    // Sessions start at version 1, but 0 is a legitimate lower bound rather
    // than a value worth special-casing at the boundary.
    expect(parse(0).expectedVersion).toBe(0);
    expect(parse(1).expectedVersion).toBe(1);
    expect(parse(42).expectedVersion).toBe(42);
  });

  it.each([
    ["a negative version", -1],
    ["a fractional version", 1.5],
    ["null", null],
    ["an empty string", ""],
    ["a numeric string", "4"],
    ["a boolean", true],
  ])("rejects %s at the request boundary", (_label, value) => {
    expect(() => parse(value)).toThrow();
  });
});
