/**
 * The Wave-0 chain vocabulary, pinned member-by-member.
 *
 * These are literal-list assertions on purpose. The lists are mirrored by hand
 * into Convex validators and read by reporting and import surfaces, so a
 * reviewer needs to see the exact words change in a diff — a test that merely
 * counted members, or re-derived the list from the enum, would pass while a
 * rename silently broke every mirror.
 *
 * `USER_VALUE_STAGES` gets an extra assertion: its ORDER is normative (stage
 * state derivation reads position to decide what was never reached), so the
 * order is pinned separately from the membership.
 */

import { describe, expect, it } from "vitest";
import {
  FAILURE_CATEGORIES,
  IMPORT_MAPPING_STATUSES,
  ITERATION_STATUSES,
  STAGE_STATES,
  USER_VALUE_STAGES,
  failureCategorySchema,
  importMappingStatusSchema,
  iterationStatusSchema,
  stageStateSchema,
  userValueStageSchema,
} from "../src/contract/chain.js";

describe("USER_VALUE_STAGES", () => {
  it("is exactly the chain, in chain order", () => {
    expect([...USER_VALUE_STAGES]).toEqual([
      "connection",
      "discovery",
      "selection",
      "call",
      "response",
      "userValue",
    ]);
  });

  it("is NOT sorted — the array order is the chain, not a display order", () => {
    // If someone ever "tidies" this list alphabetically, position-based
    // derivation ("everything after the first failure was not reached") starts
    // reporting the wrong stages as blocked. This is the assertion that catches
    // the tidy-up.
    const sorted = [...USER_VALUE_STAGES].sort();
    expect([...USER_VALUE_STAGES]).not.toEqual(sorted);
    expect(USER_VALUE_STAGES[0]).toBe("connection");
    expect(USER_VALUE_STAGES[USER_VALUE_STAGES.length - 1]).toBe("userValue");
  });
});

describe("STAGE_STATES", () => {
  it("pins all five states", () => {
    expect([...STAGE_STATES]).toEqual([
      "passed",
      "failed",
      "notReached",
      "notMeasured",
      "notApplicable",
    ]);
  });

  it("keeps the three no-verdict reasons distinct", () => {
    // `notReached`, `notMeasured` and `notApplicable` are three different
    // reasons there is no verdict. Collapsing any two is how "we never checked"
    // gets rendered as "it passed".
    const noVerdict = STAGE_STATES.filter(
      (state) => state !== "passed" && state !== "failed"
    );
    expect(noVerdict).toHaveLength(3);
    expect(new Set(noVerdict).size).toBe(3);
  });
});

describe("FAILURE_CATEGORIES", () => {
  it("pins all seven categories", () => {
    expect([...FAILURE_CATEGORIES]).toEqual([
      "setup",
      "metadata",
      "selection",
      "arguments",
      "serverData",
      "userValue",
      "evaluator",
    ]);
  });

  it("keeps `evaluator` as its own category", () => {
    // A broken judge is not a server defect. Folding it into any other bucket
    // poisons every rate derived from these categories.
    expect(FAILURE_CATEGORIES).toContain("evaluator");
  });
});

describe("ITERATION_STATUSES", () => {
  it("starts with the six statuses the backend already persists, in order", () => {
    expect([...ITERATION_STATUSES].slice(0, 6)).toEqual([
      "pending",
      "running",
      "completed",
      "failed",
      "cancelled",
      "timed_out",
    ]);
  });

  it("adds exactly the two pinned statuses", () => {
    expect([...ITERATION_STATUSES].slice(6)).toEqual([
      "setup_failed",
      "skipped",
    ]);
  });

  it("keeps setup_failed distinct from failed", () => {
    // `failed` says something about the server; `setup_failed` says something
    // about us. Merging them inflates every failure rate with harness noise.
    expect(ITERATION_STATUSES).toContain("failed");
    expect(ITERATION_STATUSES).toContain("setup_failed");
  });
});

describe("IMPORT_MAPPING_STATUSES", () => {
  it("pins all four statuses", () => {
    expect([...IMPORT_MAPPING_STATUSES]).toEqual([
      "exact",
      "approximated",
      "unsupported",
      "unresolved",
    ]);
  });
});

describe("the zod enums mirror their arrays", () => {
  const pairs = [
    ["USER_VALUE_STAGES", USER_VALUE_STAGES, userValueStageSchema],
    ["STAGE_STATES", STAGE_STATES, stageStateSchema],
    ["FAILURE_CATEGORIES", FAILURE_CATEGORIES, failureCategorySchema],
    ["ITERATION_STATUSES", ITERATION_STATUSES, iterationStatusSchema],
    [
      "IMPORT_MAPPING_STATUSES",
      IMPORT_MAPPING_STATUSES,
      importMappingStatusSchema,
    ],
  ] as const;

  for (const [label, members, schema] of pairs) {
    it(`${label}: every member parses and nothing else does`, () => {
      for (const member of members) {
        expect(schema.safeParse(member).success, member).toBe(true);
      }
      expect(schema.safeParse("definitely-not-a-member").success).toBe(false);
      expect(schema.safeParse("").success).toBe(false);
    });
  }

  it("exports no numeric encoding for stage states", () => {
    // Stage states are strings on the wire and in storage. An ordinal encoding
    // invites `state > 0` comparisons across three values that are not points
    // on a scale.
    for (const state of STAGE_STATES) {
      expect(typeof state).toBe("string");
    }
    expect(stageStateSchema.safeParse(0).success).toBe(false);
  });
});
