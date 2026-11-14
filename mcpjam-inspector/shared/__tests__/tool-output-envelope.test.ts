import { describe, expect, it } from "vitest";
import {
  readToolOutputTexts,
  unwrapToolOutputEnvelope,
} from "../tool-output-envelope";

function nest(value: unknown, depth: number): unknown {
  let current = value;
  for (let i = 0; i < depth; i += 1) current = { type: "json", value: current };
  return current;
}

/** The loop the four callers ran before the shared reader, as the oracle. */
function legacyUnwrap(value: unknown, maxDepth: number): unknown {
  let current = value;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return current;
    }
    const record = current as Record<string, unknown>;
    if (record.type !== "json" || !("value" in record)) return current;
    current = record.value;
  }
  return current;
}

describe("unwrapToolOutputEnvelope", () => {
  it("returns the same value the callers' old loops did, at their depths", () => {
    // The hydrated-output reader picks the value the server signs, so the
    // refactor must not move a single byte at depth 4 or 5.
    const inner = { type: "text", value: "x" };
    for (const maxDepth of [4, 5]) {
      for (let depth = 0; depth <= 7; depth += 1) {
        const input = nest(inner, depth);
        expect(unwrapToolOutputEnvelope(input, maxDepth).value).toBe(
          legacyUnwrap(input, maxDepth),
        );
      }
    }
    for (const input of [null, "s", 3, [nest(inner, 1)], { type: "json" }]) {
      expect(unwrapToolOutputEnvelope(input, 4).value).toEqual(
        legacyUnwrap(input, 4),
      );
    }
  });

  it("reports the limit instead of passing a half-unwrapped value off as ok", () => {
    const inner = { type: "text", value: "x" };
    expect(unwrapToolOutputEnvelope(nest(inner, 4), 4)).toEqual({
      status: "ok",
      value: inner,
    });
    const past = unwrapToolOutputEnvelope(nest(inner, 5), 4);
    expect(past.status).toBe("limit_exceeded");
    expect(past.value).toEqual(nest(inner, 1));
  });
});

describe("readToolOutputTexts", () => {
  it("reads every shape a result arrives in", () => {
    expect(readToolOutputTexts("plain")).toEqual({
      status: "ok",
      texts: [{ kind: "text", value: "plain" }],
    });
    // The hosted loop's UI output, json-wrapped on the way back.
    expect(
      readToolOutputTexts(nest({ type: "text", value: "t", _meta: {} }, 3)),
    ).toEqual({ status: "ok", texts: [{ kind: "text", value: "t" }] });
    expect(readToolOutputTexts(nest("wrapped string", 2))).toEqual({
      status: "ok",
      texts: [{ kind: "text", value: "wrapped string" }],
    });
    expect(
      readToolOutputTexts({
        type: "content",
        value: [
          { type: "text", text: "a" },
          { type: "file", data: "…", mediaType: "image/png" },
          { type: "text", text: "b" },
        ],
      }),
    ).toEqual({
      status: "ok",
      texts: [
        { kind: "text", value: "a" },
        { kind: "text", value: "b" },
      ],
    });
  });

  it("keeps error text apart from content", () => {
    expect(readToolOutputTexts({ type: "error-text", value: "boom" })).toEqual({
      status: "ok",
      texts: [{ kind: "error-text", value: "boom" }],
    });
  });

  it("reads known text-free shapes as empty, and unknown ones as unrecognized", () => {
    expect(readToolOutputTexts({ type: "execution-denied" })).toEqual({
      status: "ok",
      texts: [],
    });
    expect(readToolOutputTexts({ type: "error-json", value: {} })).toEqual({
      status: "ok",
      texts: [],
    });
    expect(readToolOutputTexts({ type: "json", value: { a: 1 } })).toEqual({
      status: "unrecognized",
    });
    expect(readToolOutputTexts(undefined)).toEqual({ status: "unrecognized" });
  });

  it("reports a nest past the limit rather than reading it as empty", () => {
    expect(readToolOutputTexts(nest("deep", 17))).toEqual({
      status: "limit_exceeded",
    });
    expect(readToolOutputTexts(nest("deep", 16))).toEqual({
      status: "ok",
      texts: [{ kind: "text", value: "deep" }],
    });
  });
});
