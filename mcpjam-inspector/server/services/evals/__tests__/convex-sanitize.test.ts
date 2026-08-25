import { describe, expect, it } from "vitest";
import {
  desanitizeFromConvexTransport,
  sanitizeForConvexTransport,
  toPersistedToolCalls,
} from "../convex-sanitize.js";

describe("sanitizeForConvexTransport", () => {
  it("rewrites reserved leading-$ object keys recursively", () => {
    expect(
      sanitizeForConvexTransport({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        nested: {
          items: [{ $ref: "#/defs/node" }, { ok: true }],
        },
      }),
    ).toEqual({
      __convexReserved__schema: "https://json-schema.org/draft/2020-12/schema",
      nested: {
        items: [{ __convexReserved__ref: "#/defs/node" }, { ok: true }],
      },
    });
  });

  it("preserves scalars and dates", () => {
    const now = new Date("2026-03-28T00:00:00.000Z");
    const value = sanitizeForConvexTransport({
      count: 3,
      label: "ok",
      createdAt: now,
    });

    expect(value).toEqual({
      count: 3,
      label: "ok",
      createdAt: now,
    });
  });

  it("round-trips reserved keys through sanitize then desanitize", () => {
    const original = {
      $schema: "https://example.com/schema",
      nested: { $ref: "#/x" },
      plain: 1,
    };
    expect(
      desanitizeFromConvexTransport(sanitizeForConvexTransport(original)),
    ).toEqual(original);
  });
});

describe("toPersistedToolCalls", () => {
  it("returns an empty array for an iteration that called no tools", () => {
    // The common case: `actualToolCalls: []` is what a no-tool iteration
    // persists, and the validator requires an array, not a missing field.
    expect(toPersistedToolCalls([])).toEqual([]);
  });

  it("keeps exactly the fields the backend validator accepts", () => {
    expect(
      toPersistedToolCalls([
        {
          toolName: "connector_list",
          arguments: { includeSourceConnectors: true },
        },
        {
          toolName: "search",
          arguments: { q: "coffee" },
          toolCallId: "toolu_01SCzFBPBXj3sQjxBSxaQcoM",
        },
      ]),
    ).toEqual([
      {
        toolName: "connector_list",
        arguments: { includeSourceConnectors: true },
      },
      {
        toolName: "search",
        arguments: { q: "coffee" },
        toolCallId: "toolu_01SCzFBPBXj3sQjxBSxaQcoM",
      },
    ]);
  });

  it("drops a field the strict validator would reject (CONVEX-1QF)", () => {
    // `updateTestIteration.actualToolCalls` is a strict `v.object`: an
    // unrecognized key fails the whole finalize call, so the boundary has to
    // project rather than trust whatever the runner attached upstream.
    const calls = toPersistedToolCalls([
      {
        toolName: "connector_list",
        arguments: { includeSourceConnectors: true },
        toolCallId: "toolu_01SCzFBPBXj3sQjxBSxaQcoM",
        providerExecuted: true,
        state: "output-available",
      } as never,
    ]);

    expect(Object.keys(calls[0]!).sort()).toEqual([
      "arguments",
      "toolCallId",
      "toolName",
    ]);
  });

  it("omits toolCallId rather than sending undefined when absent", () => {
    // `v.optional(v.string())` accepts a missing key; an explicit `undefined`
    // is what Convex serialization rejects.
    const [call] = toPersistedToolCalls([
      { toolName: "echo", arguments: {}, toolCallId: undefined },
    ]);

    expect("toolCallId" in call!).toBe(false);
  });
});
