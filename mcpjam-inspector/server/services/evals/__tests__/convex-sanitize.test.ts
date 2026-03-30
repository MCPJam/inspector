import { describe, expect, it } from "vitest";
import {
  desanitizeFromConvexTransport,
  sanitizeForConvexTransport,
} from "../convex-sanitize.js";

describe("sanitizeForConvexTransport", () => {
  it("rewrites reserved leading-$ object keys recursively", () => {
    expect(
      sanitizeForConvexTransport({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        nested: {
          items: [
            { $ref: "#/defs/node" },
            { ok: true },
          ],
        },
      }),
    ).toEqual({
      __convexReserved__schema:
        "https://json-schema.org/draft/2020-12/schema",
      nested: {
        items: [
          { __convexReserved__ref: "#/defs/node" },
          { ok: true },
        ],
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
    expect(desanitizeFromConvexTransport(sanitizeForConvexTransport(original))).toEqual(
      original,
    );
  });
});
