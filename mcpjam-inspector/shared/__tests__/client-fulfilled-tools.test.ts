import { describe, expect, it } from "vitest";
import {
  BROWSER_INTERACTIVE_TOOL_NAMES,
  BROWSER_OBSERVATION_TOOL_NAMES,
  BROWSER_TOOL_NAMES,
  isBrowserToolName,
  isAppToolAlias,
  isClientFulfilledToolName,
  isUiToolName,
  pageToolCallNeedsApproval,
  uiToolApprovalFloor,
  uiToolCallNeedsApproval,
} from "../client-fulfilled-tools";

describe("client-fulfilled tool names", () => {
  it("matches app aliases", () => {
    expect(isAppToolAlias("app_abcd1234")).toBe(true);
    expect(isAppToolAlias("app_ABCD1234")).toBe(true); // case-insensitive
    expect(isAppToolAlias("app_abcd123")).toBe(false); // 7 hex
    expect(isAppToolAlias("app_abcd12345")).toBe(false); // 9 hex
    expect(isAppToolAlias("ui_navigate")).toBe(false);
  });

  it("matches curated ui_ names", () => {
    expect(isUiToolName("ui_navigate")).toBe(true);
    expect(isUiToolName("ui_set_app_context")).toBe(true);
    expect(isUiToolName("ui_a")).toBe(true);
    expect(isUiToolName(`ui_${"a".repeat(61)}`)).toBe(true); // 64 chars total
    expect(isUiToolName(`ui_${"a".repeat(62)}`)).toBe(false); // 65 chars
    expect(isUiToolName("ui_")).toBe(false); // nothing after prefix
    expect(isUiToolName("ui__leading_underscore")).toBe(false);
    expect(isUiToolName("ui_Navigate")).toBe(false); // uppercase
    expect(isUiToolName("ui_with-hyphen")).toBe(false);
    expect(isUiToolName("uinavigate")).toBe(false);
    expect(isUiToolName("app_abcd1234")).toBe(false);
  });

  it("isClientFulfilledToolName is the union of both namespaces", () => {
    expect(isClientFulfilledToolName("app_abcd1234")).toBe(true);
    expect(isClientFulfilledToolName("ui_navigate")).toBe(true);
    expect(isClientFulfilledToolName("regular_tool")).toBe(false);
    expect(isClientFulfilledToolName("ui-navigate")).toBe(false);
  });

  it("uiToolCallNeedsApproval gates mutating tools only when the flag is on (legacy, no annotations)", () => {
    // The truth table both the server gate and the client defer read.
    expect(
      uiToolCallNeedsApproval({ readOnly: false, requireToolApproval: true }),
    ).toBe(true);
    expect(
      uiToolCallNeedsApproval({ readOnly: true, requireToolApproval: true }),
    ).toBe(false);
    expect(
      uiToolCallNeedsApproval({ readOnly: false, requireToolApproval: false }),
    ).toBe(false);
    expect(
      uiToolCallNeedsApproval({ readOnly: true, requireToolApproval: false }),
    ).toBe(false);
  });

  describe("uiToolCallNeedsApproval with MCP annotations", () => {
    const additive = { readOnlyHint: false, destructiveHint: false };
    const destructive = { readOnlyHint: false, destructiveHint: true };
    const readOnly = { readOnlyHint: true, destructiveHint: false };

    it("gates destructive tools even when the flag is OFF", () => {
      // The whole point of the annotation work: `requireToolApproval` is off
      // by default, and a destructive action must still confirm.
      expect(
        uiToolCallNeedsApproval({
          readOnly: false,
          annotations: destructive,
          requireToolApproval: false,
        }),
      ).toBe(true);
    });

    it("does not gate additive tools when the flag is OFF", () => {
      expect(
        uiToolCallNeedsApproval({
          readOnly: false,
          annotations: additive,
          requireToolApproval: false,
        }),
      ).toBe(false);
    });

    it("gates every mutating tool when the flag is ON", () => {
      for (const annotations of [additive, destructive]) {
        expect(
          uiToolCallNeedsApproval({
            readOnly: false,
            annotations,
            requireToolApproval: true,
          }),
        ).toBe(true);
      }
    });

    it("never gates read-only tools, in either mode", () => {
      for (const requireToolApproval of [true, false]) {
        expect(
          uiToolCallNeedsApproval({
            readOnly: true,
            annotations: readOnly,
            requireToolApproval,
          }),
        ).toBe(false);
      }
    });

    it("treats an absent destructiveHint as destructive (protocol default)", () => {
      // A tool added without annotating destructiveHint must fail SAFE.
      expect(
        uiToolCallNeedsApproval({
          readOnly: false,
          annotations: { readOnlyHint: false },
          requireToolApproval: false,
        }),
      ).toBe(true);
      expect(
        uiToolCallNeedsApproval({
          readOnly: false,
          annotations: {},
          requireToolApproval: false,
        }),
      ).toBe(true);
    });

    it("fails CLOSED on a contradictory read-only + destructive entry", () => {
      // The validator rejects `readOnlyHint` disagreeing with `readOnly`, but
      // nothing stops "read-only AND destructive". Resolving that in favor of
      // "don't ask" is the one reading that can silently delete something, so
      // destructive wins.
      for (const requireToolApproval of [true, false]) {
        expect(
          uiToolCallNeedsApproval({
            readOnly: true,
            annotations: { readOnlyHint: true, destructiveHint: true },
            requireToolApproval,
          }),
        ).toBe(true);
      }
    });

    it("does not gate a read-only tool whose annotations omit readOnlyHint", () => {
      // Partial annotations must not lose the legacy signal — otherwise a
      // snapshot gets gated for no reason in strict mode.
      expect(
        uiToolCallNeedsApproval({
          readOnly: true,
          annotations: { destructiveHint: false },
          requireToolApproval: true,
        }),
      ).toBe(false);
    });

    it("ignores non-approval hints", () => {
      expect(
        uiToolCallNeedsApproval({
          readOnly: false,
          annotations: {
            ...additive,
            idempotentHint: false,
            openWorldHint: true,
          },
          requireToolApproval: false,
        }),
      ).toBe(false);
    });
  });
});

describe("browser tool names", () => {
  it("identifies browser tool names", () => {
    expect(isBrowserToolName("browser_act")).toBe(true);
    expect(isBrowserToolName("browser_observe")).toBe(true);
    expect(isBrowserToolName("bash")).toBe(false);
    expect(isBrowserToolName("page_1234abcd")).toBe(false);
  });

  it("splits every verb into exactly one of observation / interactive", () => {
    // The split is what lets an unattended read-only run be BUILT with only
    // the tools that look — `buildBrowserTools` filters on it. A verb in
    // neither set would be silently dropped from every run; one in both would
    // make "read-only" mean whichever set was checked first.
    for (const name of BROWSER_TOOL_NAMES) {
      const observation = BROWSER_OBSERVATION_TOOL_NAMES.has(name);
      const interactive = BROWSER_INTERACTIVE_TOOL_NAMES.has(name);
      expect(observation !== interactive, name).toBe(true);
    }
    expect(BROWSER_TOOL_NAMES).toHaveLength(
      BROWSER_OBSERVATION_TOOL_NAMES.size + BROWSER_INTERACTIVE_TOOL_NAMES.size,
    );
  });
});

/**
 * The floor each entry sits at, asserted apart from the switch.
 *
 * `uiToolCallNeedsApproval` above answers the combined question; this answers
 * the one the entry alone decides, which is what a future setting will vary.
 */
describe("uiToolApprovalFloor", () => {
  it("reads destructive as `always` and read-only as `never`", () => {
    expect(
      uiToolApprovalFloor({
        readOnly: false,
        annotations: { destructiveHint: true },
      }),
    ).toBe("always");
    expect(
      uiToolApprovalFloor({
        readOnly: true,
        annotations: { readOnlyHint: true, destructiveHint: false },
      }),
    ).toBe("never");
    expect(uiToolApprovalFloor({ readOnly: true })).toBe("never");
  });

  it("reads an additive annotated tool as `setting`", () => {
    expect(
      uiToolApprovalFloor({
        readOnly: false,
        annotations: { readOnlyHint: false, destructiveHint: false },
      }),
    ).toBe("setting");
    // Legacy (no annotations) mutating entry: the flag alone, as before.
    expect(uiToolApprovalFloor({ readOnly: false })).toBe("setting");
  });

  it("reads an ABSENT destructiveHint as `always` (protocol default)", () => {
    expect(uiToolApprovalFloor({ readOnly: false, annotations: {} })).toBe(
      "always",
    );
  });
});

describe("pageToolCallNeedsApproval", () => {
  it("is `always`, and says so without consulting anything", () => {
    expect(pageToolCallNeedsApproval()).toBe(true);
  });
});
