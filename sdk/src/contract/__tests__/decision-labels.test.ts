import { describe, expect, it } from "vitest";
import {
  STAGE_REASONS,
  STAGE_REASONS_WITHOUT_REMEDY,
  STAGE_REASON_REMEDIES,
  type StageReason,
} from "../index.js";

const remedied = Object.keys(STAGE_REASON_REMEDIES) as StageReason[];
const unremedied = STAGE_REASONS_WITHOUT_REMEDY as readonly StageReason[];

describe("stage reason remedies", () => {
  // The totality test. `STAGE_REASON_REMEDIES` is deliberately `Partial`, so
  // the compiler cannot hold it to the vocabulary the way it holds the total
  // maps beside it. This partition is what replaces that: adding a reason to
  // the contract fails here until somebody decides whether it has a next step
  // for the reader or an honest nothing.
  it("partitions STAGE_REASONS with the deliberate exclusions", () => {
    expect(new Set(remedied).size).toBe(remedied.length);
    expect(new Set(unremedied).size).toBe(unremedied.length);

    const overlap = remedied.filter((reason) => unremedied.includes(reason));
    expect(overlap).toEqual([]);

    expect([...remedied, ...unremedied].sort()).toEqual(
      [...STAGE_REASONS].sort()
    );
  });

  // A remedy is spliced into a sentence by its caller, so a trailing stop
  // would render mid-line.
  it("has a non-empty remedy that does not end a sentence", () => {
    for (const [reason, remedy] of Object.entries(STAGE_REASON_REMEDIES)) {
      expect(remedy.trim(), reason).not.toBe("");
      expect(remedy.endsWith("."), reason).toBe(false);
    }
  });

  // The two spellings this vocabulary is not allowed to put in front of a
  // reader: "root cause" claims a diagnosis no remedy here makes, and
  // `userValue` is a wire spelling that no rendered sentence should carry.
  it("never says root cause, and never renders a wire spelling", () => {
    for (const [reason, remedy] of Object.entries(STAGE_REASON_REMEDIES)) {
      expect(remedy.toLowerCase(), reason).not.toContain("root cause");
      expect(remedy, reason).not.toContain("userValue");
    }
  });

  // The specific mistake the `Partial` exists to prevent. `providerError` is
  // OUR side of the call breaking — a provider outage, a rate limit, one of
  // our own spend guardrails — so the run says nothing about the server under
  // test. A remedy here would tell a pull request author to go and fix a
  // system they do not own and that is not involved.
  it("offers no remedy for a failure on MCPJam's own side", () => {
    expect(STAGE_REASON_REMEDIES).not.toHaveProperty("providerError");
    expect(unremedied).toContain("providerError");
  });
});
