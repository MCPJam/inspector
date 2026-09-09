/**
 * The `intent` contract — analytics metadata, and the three-way update rule.
 *
 * Organized around the ways a label gets LOST rather than around the code's
 * branches, because every bug this contract can have looks the same to an
 * author: they typed a label, and later it was gone.
 *
 *   - an old client that omits the field must not clear it;
 *   - an authoritative `null` must clear it;
 *   - "" and "   " are absence, and absence has exactly one spelling;
 *   - historical absence stays absent — nothing manufactures a bucket;
 *   - and retagging must not disturb an importer's exactness claim.
 */

import { describe, expect, test } from "vitest";
import {
  INTENT_EXCLUDED_FROM_SEMANTIC_EXACTNESS,
  MAX_INTENT_CHARS,
  UNLABELED_INTENT_LABEL,
  caseIntentSchema,
  caseIntentUpdateSchema,
  intentFingerprintValue,
  intentSliceKey,
  normalizeIntent,
  resolveIntentUpdate,
} from "../src/contract/index.js";

describe("bounds", () => {
  test("accepts a trimmed label at both ends of the range", () => {
    expect(caseIntentSchema.safeParse("s").success).toBe(true);
    expect(
      caseIntentSchema.safeParse("x".repeat(MAX_INTENT_CHARS)).success
    ).toBe(true);
  });

  test("rejects empty, over-long, and untrimmed values", () => {
    expect(caseIntentSchema.safeParse("").success).toBe(false);
    expect(
      caseIntentSchema.safeParse("x".repeat(MAX_INTENT_CHARS + 1)).success
    ).toBe(false);
    expect(caseIntentSchema.safeParse(" search ").success).toBe(false);
  });

  test("`null` is legal only on the wire form", () => {
    expect(caseIntentSchema.safeParse(null).success).toBe(false);
    expect(caseIntentUpdateSchema.safeParse(null).success).toBe(true);
  });
});

describe("normalizeIntent", () => {
  test("trims", () => {
    expect(normalizeIntent("  search  ")).toBe("search");
  });

  test("every shape of nothing normalizes to the SAME nothing", () => {
    // One spelling of absence. Two would eventually render as an empty row.
    for (const value of [undefined, null, "", "   ", "\t\n", 42, {}]) {
      expect(normalizeIntent(value)).toBeUndefined();
    }
  });

  test("does not truncate an over-long label", () => {
    // Truncating would invent a label the author never wrote AND merge two
    // distinct intents that share a prefix. It is returned intact so the
    // schema can reject it and the author is told.
    const long = "x".repeat(MAX_INTENT_CHARS + 10);
    expect(normalizeIntent(long)).toBe(long);
    expect(caseIntentSchema.safeParse(normalizeIntent(long)).success).toBe(
      false
    );
  });
});

describe("resolveIntentUpdate — the three-way rule", () => {
  test("omitted PRESERVES: an old client must not strip labels", () => {
    expect(resolveIntentUpdate(undefined)).toEqual({
      changed: false,
      value: undefined,
    });
  });

  test("null CLEARS", () => {
    expect(resolveIntentUpdate(null)).toEqual({
      changed: true,
      value: undefined,
    });
  });

  test("a string SETS, normalized", () => {
    expect(resolveIntentUpdate("  search ")).toEqual({
      changed: true,
      value: "search",
    });
  });

  test("an explicitly empty string is a CLEAR, not an omission", () => {
    // The caller did speak; what they said was "no label".
    expect(resolveIntentUpdate("   ")).toEqual({
      changed: true,
      value: undefined,
    });
  });

  test("omitted and null are not interchangeable", () => {
    expect(resolveIntentUpdate(undefined).changed).not.toBe(
      resolveIntentUpdate(null).changed
    );
  });
});

describe("absence", () => {
  test("unlabelled keys on null, never on the display word", () => {
    expect(intentSliceKey(undefined)).toBeNull();
    expect(intentSliceKey("")).toBeNull();
    // A case literally labelled "Unlabeled" is a DIFFERENT, labelled slice —
    // keying on the display word would silently merge the two.
    expect(intentSliceKey(UNLABELED_INTENT_LABEL)).toBe(UNLABELED_INTENT_LABEL);
  });

  test("nothing manufactures a default bucket", () => {
    expect(intentSliceKey(undefined)).not.toBe("general");
  });
});

describe("fingerprinting vs. exactness", () => {
  test("intent participates in the authored-config fingerprint", () => {
    expect(intentFingerprintValue("search")).not.toBe(
      intentFingerprintValue("browse")
    );
    // Absence has ONE fingerprint value, so a retag to "" does not rotate a
    // revision that was already unlabelled.
    expect(intentFingerprintValue(undefined)).toBe(
      intentFingerprintValue("  ")
    );
  });

  test("intent is excluded from import semantic exactness", () => {
    // The two rules point opposite ways on purpose: exactness asks "does this
    // case MEAN the same thing" (intent does not participate), fingerprinting
    // asks "is this the same authored configuration" (it does).
    expect(INTENT_EXCLUDED_FROM_SEMANTIC_EXACTNESS).toBe(true);
  });
});
