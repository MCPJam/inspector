import { describe, expect, it } from "vitest";
import {
  classifyUiToolApprovals,
  isAppToolAlias,
  isClientFulfilledToolName,
  isUiToolName,
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

    it("gates destructive tools even when the flag is OFF", () => {
      // The whole point of the annotation work: `requireToolApproval` is off
      // by default, and a destructive action must still confirm.
      expect(
        uiToolCallNeedsApproval({
          readOnly: false,
          annotations: destructive,
          requireToolApproval: false,
        })
      ).toBe(true);
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

    it("treats an absent destructiveHint as destructive (protocol default)", () => {
      // A tool added without annotating destructiveHint must fail SAFE.
      expect(
        uiToolCallNeedsApproval({
          readOnly: false,
          annotations: { readOnlyHint: false },
          requireToolApproval: false,
        })
      ).toBe(true);
      expect(
        uiToolCallNeedsApproval({
          readOnly: false,
          annotations: {},
          requireToolApproval: false,
        })
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
        })
      ).toBe(false);
    });
  });

  describe("classifyUiToolApprovals", () => {
    const entries = [
      {
        name: "ui_snapshot_app",
        readOnly: true,
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      {
        name: "ui_navigate",
        readOnly: false,
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      {
        name: "ui_execute_tool",
        readOnly: false,
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
    ];

    it("splits destructive from free in default mode", () => {
      const { requiredNames, freeNames } = classifyUiToolApprovals(
        entries,
        false
      );
      expect([...requiredNames]).toEqual(["ui_execute_tool"]);
      expect([...freeNames].sort()).toEqual(["ui_navigate", "ui_snapshot_app"]);
    });

    it("moves every mutating tool to required in strict mode, keeping read-only free", () => {
      const { requiredNames, freeNames } = classifyUiToolApprovals(
        entries,
        true
      );
      expect([...requiredNames].sort()).toEqual([
        "ui_execute_tool",
        "ui_navigate",
      ]);
      // Strict mode still must not pause a snapshot — this is why the engine
      // needs `freeNames` and not just "absent from requiredNames".
      expect([...freeNames]).toEqual(["ui_snapshot_app"]);
    });

    it("places every entry in exactly one set", () => {
      for (const strict of [true, false]) {
        const { requiredNames, freeNames } = classifyUiToolApprovals(
          entries,
          strict
        );
        expect(requiredNames.size + freeNames.size).toBe(entries.length);
        for (const name of requiredNames) {
          expect(freeNames.has(name)).toBe(false);
        }
      }
    });

    it("handles an absent snapshot", () => {
      const { requiredNames, freeNames } = classifyUiToolApprovals(
        undefined,
        false
      );
      expect(requiredNames.size).toBe(0);
      expect(freeNames.size).toBe(0);
    });

    it("classifies legacy entries (no annotations) by the flag alone", () => {
      const legacy = [
        { name: "ui_navigate", readOnly: false },
        { name: "ui_snapshot_app", readOnly: true },
      ];
      expect([...classifyUiToolApprovals(legacy, false).requiredNames]).toEqual(
        []
      );
      expect([...classifyUiToolApprovals(legacy, true).requiredNames]).toEqual([
        "ui_navigate",
      ]);
    });
  });
});
