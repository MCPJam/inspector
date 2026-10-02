import { describe, expect, it } from "vitest";
import {
  TOOL_POLICY_BLOCK_MARKER,
  UnmatchedToolPolicyNameError,
  classifyToolSafety,
  decideToolPolicy,
  isToolPolicyBlockResult,
  validateToolPolicyNames,
  type EvalSuiteFileToolPolicy,
} from "../index.js";

const policy = (overrides: Partial<EvalSuiteFileToolPolicy> = {}) => ({
  mode: "default" as const,
  ...overrides,
});

describe("tool policy precedence", () => {
  it("deny beats allow", () => {
    expect(
      decideToolPolicy({
        toolName: "write",
        annotations: { destructiveHint: true },
        policy: policy({ allow: ["write"], deny: ["write"] }),
      })
    ).toMatchObject({
      allowed: false,
      reason: "denyList",
      classification: "destructive",
    });
  });

  it("denies destructive tools by default without an allowlist", () => {
    expect(
      decideToolPolicy({
        toolName: "write",
        annotations: { destructiveHint: true },
        policy: policy(),
      })
    ).toMatchObject({ allowed: false, reason: "destructiveDefaultDeny" });
  });

  it("allows a destructive tool explicitly listed in allow", () => {
    expect(
      decideToolPolicy({
        toolName: "write",
        annotations: { destructiveHint: true },
        policy: policy({ allow: ["write"] }),
      })
    ).toMatchObject({ allowed: true, reason: "allowList" });
  });

  it("blocks unclassified tools in readOnly mode", () => {
    expect(
      decideToolPolicy({
        toolName: "unknown",
        policy: policy({ mode: "readOnly" }),
      })
    ).toMatchObject({
      allowed: false,
      reason: "readOnlyModeUnclassified",
      classification: "unknown",
    });
  });

  it("allows explicitly read-only tools in readOnly mode", () => {
    expect(
      decideToolPolicy({
        toolName: "read",
        annotations: { readOnlyHint: true },
        policy: policy({ mode: "readOnly" }),
      })
    ).toMatchObject({
      allowed: true,
      reason: "readOnlyModeClassified",
      classification: "readOnly",
    });
  });

  it("treats contradictory annotations as unknown", () => {
    const annotations = { readOnlyHint: true, destructiveHint: true };
    expect(classifyToolSafety(annotations)).toBe("unknown");
    expect(
      decideToolPolicy({
        toolName: "contradictory",
        annotations,
        policy: policy({ mode: "readOnly" }),
      })
    ).toMatchObject({ allowed: false, reason: "destructiveDefaultDeny" });
    expect(
      decideToolPolicy({
        toolName: "contradictory",
        annotations,
        policy: policy(),
      })
    ).toMatchObject({
      allowed: false,
      reason: "destructiveDefaultDeny",
      classification: "unknown",
    });
  });

  it("allows unknown annotations in default mode", () => {
    expect(
      decideToolPolicy({
        toolName: "unknown",
        policy: policy(),
      })
    ).toMatchObject({ allowed: true, reason: "modeDefault" });
  });

  it.each([
    undefined,
    { readOnlyHint: "true" },
    { destructiveHint: 1 },
    { readOnlyHint: null, destructiveHint: false },
    { readOnlyHint: false, destructiveHint: false },
  ])("treats garbage annotation values as unknown: %j", (annotations) => {
    expect(classifyToolSafety(annotations)).toBe("unknown");
  });
});

describe("validateToolPolicyNames", () => {
  const available = ["read_note", "delete_note", "echo"];

  it("refuses a deny name that matches nothing, naming every one", () => {
    let thrown: unknown;
    try {
      validateToolPolicyNames({
        policy: policy({ deny: ["delete_notes", "drop_table", "echo"] }),
        availableToolNames: available,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnmatchedToolPolicyNameError);
    const error = thrown as UnmatchedToolPolicyNameError;
    expect(error.code).toBe("TOOL_POLICY_INVALID");
    expect(error.names).toEqual(["delete_notes", "drop_table"]);
    expect(error.message).toBe(
      "TOOL_POLICY_INVALID: Tool policy deny name(s) did not match any available tool: delete_notes, drop_table"
    );
  });

  it("warns, not refuses, for a deferred deny name and an unmatched allow", () => {
    expect(
      validateToolPolicyNames({
        policy: policy({ deny: ["later_tool"], allow: ["ghost"] }),
        availableToolNames: available,
        deferredToolNames: ["later_tool"],
      })
    ).toEqual([
      "Tool policy deny name(s) could not be resolved at run start: later_tool",
      "Tool policy allow name(s) did not match any available tool: ghost",
    ]);
  });

  it("says nothing when every name matches", () => {
    expect(
      validateToolPolicyNames({
        policy: policy({ deny: ["delete_note"], allow: ["echo"] }),
        availableToolNames: available,
      })
    ).toEqual([]);
  });
});

describe("the policy block marker", () => {
  it("is the wire-stable key every enforcement point writes and reads", () => {
    // Persisted in traces and read by the server's trace capture: renaming it
    // would make every existing block look like an executed call.
    expect(TOOL_POLICY_BLOCK_MARKER).toBe("mcpjamPolicyBlock");
  });

  it("recognizes only a result that carries the marker as true", () => {
    expect(
      isToolPolicyBlockResult({
        content: [{ type: "text", text: "Call blocked by tool policy" }],
        [TOOL_POLICY_BLOCK_MARKER]: true,
      })
    ).toBe(true);
    expect(
      isToolPolicyBlockResult({ [TOOL_POLICY_BLOCK_MARKER]: "true" })
    ).toBe(false);
    expect(isToolPolicyBlockResult({ content: [] })).toBe(false);
    expect(isToolPolicyBlockResult(null)).toBe(false);
    expect(isToolPolicyBlockResult("mcpjamPolicyBlock")).toBe(false);
  });
});
