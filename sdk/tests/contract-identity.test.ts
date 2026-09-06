/**
 * The opaque-id rule and the minters.
 *
 * The charset is the whole contract here: ids end up in URLs, file paths, YAML
 * keys and CLI arguments, so the accept/reject cohorts below are about where an
 * id can safely travel, not about aesthetics.
 */

import { describe, expect, it } from "vitest";
import {
  CASE_ID_PREFIX,
  MAX_OPAQUE_ID_LENGTH,
  MINTED_ID_ENTROPY_CHARS,
  SUITE_ID_PREFIX,
  isOpaqueId,
  mintCaseId,
  mintSuiteId,
  opaqueIdSchema,
} from "../src/contract/identity.js";

describe("opaqueIdSchema", () => {
  const accept: Array<[string, string]> = [
    ["a Convex document id", "jd7fk3m2q9x5p1v8s4t6w0y2z"],
    ["an inspector-authored id", "ui_V1StGXR8Z5jdHi6Bmy"],
    ["a minted case id", "c_V1StGXR8Z5jdHi6Bmy"],
    ["a hand-authored id", "refund-flow-1"],
    ["a single character", "a"],
    ["the maximum length", "a".repeat(MAX_OPAQUE_ID_LENGTH)],
  ];

  for (const [label, value] of accept) {
    it(`accepts ${label}`, () => {
      expect(opaqueIdSchema.safeParse(value).success).toBe(true);
      expect(isOpaqueId(value)).toBe(true);
    });
  }

  const reject: Array<[string, unknown]> = [
    ["the empty string", ""],
    ["an id with a space", "refund flow"],
    ["an id with a slash — it would split a URL path", "refunds/1"],
    ["an id with a dot — it would look like a file extension", "case.1"],
    ["an id with a colon", "external:case_1"],
    ["an id with a newline", "case\n1"],
    ["an id past the maximum length", "a".repeat(MAX_OPAQUE_ID_LENGTH + 1)],
    ["a number", 42],
    ["null", null],
    ["undefined", undefined],
  ];

  for (const [label, value] of reject) {
    it(`rejects ${label}`, () => {
      expect(opaqueIdSchema.safeParse(value).success).toBe(false);
      expect(isOpaqueId(value)).toBe(false);
    });
  }
});

describe("minting", () => {
  it("mints case ids with the case prefix and the pinned entropy", () => {
    const id = mintCaseId();
    expect(id.startsWith(CASE_ID_PREFIX)).toBe(true);
    expect(id).toHaveLength(CASE_ID_PREFIX.length + MINTED_ID_ENTROPY_CHARS);
    expect(opaqueIdSchema.safeParse(id).success).toBe(true);
  });

  it("mints suite ids with the suite prefix", () => {
    const id = mintSuiteId();
    expect(id.startsWith(SUITE_ID_PREFIX)).toBe(true);
    expect(id).toHaveLength(SUITE_ID_PREFIX.length + MINTED_ID_ENTROPY_CHARS);
    expect(opaqueIdSchema.safeParse(id).success).toBe(true);
  });

  it("does not repeat itself", () => {
    const minted = new Set(Array.from({ length: 500 }, () => mintCaseId()));
    expect(minted.size).toBe(500);
  });

  it("draws only from the URL-safe alphabet", () => {
    // `byte & 63` over a 64-character alphabet: every draw must land inside it,
    // and an off-by-one in the alphabet would show up as `undefined` in the id.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      expect(mintCaseId()).toMatch(/^c_[A-Za-z0-9_-]{21}$/);
    }
  });

  it("never requires our prefix to validate", () => {
    // Ids are OPAQUE. A validator that demanded `c_` would reject every id the
    // platform has already issued.
    expect(opaqueIdSchema.safeParse("jd7fk3m2q9x5p1v8s4t6w0y2z").success).toBe(
      true
    );
  });
});
