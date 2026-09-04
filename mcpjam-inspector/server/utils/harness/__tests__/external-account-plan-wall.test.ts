import { describe, expect, it } from "vitest";
import {
  EXTERNAL_ACCOUNT_PLAN_WALL_TEXTS,
  externalAccountPlanWallError,
  isExternalAccountPlanWallTurn,
} from "../external-account-plan-wall";

/**
 * The detector is deliberately hard to trigger, and most of these cases exist
 * to prove it STAYS that way: a false positive discards a real answer the
 * customer paid for, which is strictly worse than recording a bad turn.
 */
const WALL = EXTERNAL_ACCOUNT_PLAN_WALL_TEXTS[0]!;

const clean = {
  finishReason: "stop",
  successfulToolCalls: 0,
};

describe("isExternalAccountPlanWallTurn", () => {
  it("fires on the exact observed wall text", () => {
    expect(isExternalAccountPlanWallTurn({ ...clean, finalText: WALL })).toBe(
      true,
    );
  });

  it("tolerates surrounding and collapsed whitespace only", () => {
    expect(
      isExternalAccountPlanWallTurn({ ...clean, finalText: `\n  ${WALL}\t\n` }),
    ).toBe(true);
    expect(
      isExternalAccountPlanWallTurn({
        ...clean,
        finalText: WALL.replace(/ /g, "  "),
      }),
    ).toBe(true);
  });

  it("does NOT fire on a turn that merely quotes the phrase", () => {
    // The case the exact-match rule exists for. A substring test would classify
    // every one of these as a wall and delete a real answer.
    for (const text of [
      `The CLI told me to "${WALL}", so you may need a different plan.`,
      `${WALL} — that's what it said.`,
      `Here's what happened: ${WALL}`,
      `${WALL} ${WALL}`,
    ]) {
      expect(isExternalAccountPlanWallTurn({ ...clean, finalText: text })).toBe(
        false,
      );
    }
  });

  it("does NOT fire when a tool call succeeded", () => {
    // A turn that actually did work is a real turn whatever it then said.
    expect(
      isExternalAccountPlanWallTurn({
        ...clean,
        finalText: WALL,
        successfulToolCalls: 1,
      }),
    ).toBe(false);
  });

  it("does NOT fire on anything but a plain stop", () => {
    // A length cut-off, an error, or a tool-call pause are all their own
    // failures with their own handling; misreading one as an entitlement wall
    // would report the wrong cause.
    for (const finishReason of [
      "length",
      "error",
      "tool-calls",
      "content-filter",
      "unknown",
    ]) {
      expect(
        isExternalAccountPlanWallTurn({
          ...clean,
          finalText: WALL,
          finishReason,
        }),
      ).toBe(false);
    }
  });

  it("does NOT fire on empty, missing, or unrelated text", () => {
    for (const finalText of [
      undefined,
      null,
      "",
      "   ",
      "Here is the forecast for San Francisco.",
      // Case and punctuation are NOT normalized away: widening the match is a
      // step toward discarding real output, so a near-miss stays a miss.
      WALL.toLowerCase(),
      `${WALL}.`,
    ]) {
      expect(isExternalAccountPlanWallTurn({ ...clean, finalText })).toBe(
        false,
      );
    }
  });
});

describe("externalAccountPlanWallError", () => {
  it("names the runtime and the account, not MCPJam", () => {
    // Nothing about this is an MCPJam limit; copy that read like one would send
    // the reader to the wrong place entirely.
    const message = externalAccountPlanWallError("Cursor CLI").message;
    expect(message).toContain("Cursor CLI");
    expect(message).toContain("CURSOR_API_KEY");
    expect(message).toMatch(/Cursor account/i);
  });

  it("says why the turn is recorded as a failure", () => {
    // The turn LOOKS successful to the runtime, so the error has to explain why
    // it is being failed — otherwise it reads as MCPJam losing an answer.
    expect(externalAccountPlanWallError("Cursor CLI").message).toMatch(
      /model never ran|failed turn/i,
    );
  });
});
