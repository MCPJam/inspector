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
      uiToolCallNeedsApproval({ readOnly: false, requireToolApproval: true })
    ).toBe(true);
    expect(
      uiToolCallNeedsApproval({ readOnly: true, requireToolApproval: true })
    ).toBe(false);
    expect(
      uiToolCallNeedsApproval({ readOnly: false, requireToolApproval: false })
    ).toBe(false);
    expect(
      uiToolCallNeedsApproval({ readOnly: true, requireToolApproval: false })
    ).toBe(false);
  });

  describe("uiToolCallNeedsApproval with MCP annotations", () => {
    const additive = { readOnlyHint: false, destructiveHint: false };
    const destructive = { readOnlyHint: false, destructiveHint: true };
    const readOnly = { readOnlyHint: true, destructiveHint: false };

    it("leaves a destructive tool to the switch, in both directions", () => {
      // `destructiveHint` decides whether this entry is a READ or an ACTION.
      // It used to decide FOR the user as well, which made "Tool Approval:
      // off" untrue.
      expect(
        uiToolCallNeedsApproval({
          readOnly: false,
          annotations: destructive,
          requireToolApproval: true,
        })
      ).toBe(true);
      expect(
        uiToolCallNeedsApproval({
          readOnly: false,
          annotations: destructive,
          requireToolApproval: false,
        })
      ).toBe(false);
    });

    it("does not gate additive tools when the flag is OFF", () => {
      expect(
        uiToolCallNeedsApproval({
          readOnly: false,
          annotations: additive,
          requireToolApproval: false,
        })
      ).toBe(false);
    });

    it("gates every mutating tool when the flag is ON", () => {
      for (const annotations of [additive, destructive]) {
        expect(
          uiToolCallNeedsApproval({
            readOnly: false,
            annotations,
            requireToolApproval: true,
          })
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
          })
        ).toBe(false);
      }
    });

    it("treats an absent destructiveHint as an ACTION, not a read", () => {
      // The protocol default still applies where it decides something: an
      // unannotated entry is an action, so it follows the switch rather than
      // joining the reads that never ask.
      for (const annotations of [{ readOnlyHint: false }, {}]) {
        expect(
          uiToolCallNeedsApproval({
            readOnly: false,
            annotations,
            requireToolApproval: true,
          })
        ).toBe(true);
        expect(
          uiToolCallNeedsApproval({
            readOnly: false,
            annotations,
            requireToolApproval: false,
          })
        ).toBe(false);
      }
    });

    it("reads a contradictory read-only + destructive entry as an ACTION", () => {
      // The validator rejects `readOnlyHint` disagreeing with `readOnly`, but
      // nothing stops "read-only AND destructive". Resolving that in favor of
      // "this is a read" is the one reading that can silently delete
      // something, so destructive still wins the READ-or-ACTION question —
      // and the switch then answers the only question left.
      expect(
        uiToolCallNeedsApproval({
          readOnly: true,
          annotations: { readOnlyHint: true, destructiveHint: true },
          requireToolApproval: true,
        }),
      ).toBe(true);
      expect(
        uiToolCallNeedsApproval({
          readOnly: true,
          annotations: { readOnlyHint: true, destructiveHint: true },
          requireToolApproval: false,
        }),
      ).toBe(false);
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
        })
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
  it("reads destructive as `setting` and read-only as `never`", () => {
    expect(
      uiToolApprovalFloor({
        readOnly: false,
        annotations: { destructiveHint: true },
      }),
    ).toBe("setting");
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

  it("reads an ABSENT destructiveHint as an action, not a read", () => {
    // The protocol default is "assume destructive". That still keeps an
    // unannotated entry out of the `never` bucket; it no longer promotes it
    // above the user's switch.
    expect(uiToolApprovalFloor({ readOnly: false, annotations: {} })).toBe(
      "setting",
    );
  });
});

describe("pageToolCallNeedsApproval", () => {
  it("follows the user's switch, in both directions", () => {
    // It was unconditional, and the page's annotations are still never read —
    // they are claims by the party whose code would run. What the switch buys
    // is that "off" means off: a family answering "not you" is a setting that
    // does not work, which costs more trust than the pill bought safety.
    expect(pageToolCallNeedsApproval(true)).toBe(true);
    expect(pageToolCallNeedsApproval(false)).toBe(false);
  });
});
