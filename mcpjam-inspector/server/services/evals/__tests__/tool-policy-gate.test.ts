import { describe, expect, it, vi } from "vitest";
import {
  createToolPolicyGate,
  toolAnnotationsKey,
  validateToolPolicyNames,
} from "../tool-policy-gate";

describe("createToolPolicyGate", () => {
  it("blocks without executing and returns a normal marked result", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "server result" }],
    });
    const gate = createToolPolicyGate({
      policy: { mode: "default" },
      annotations: new Map([
        [toolAnnotationsKey("server-1", "write"), { destructiveHint: true }],
      ]),
    });
    const wrapped = gate.wrap({
      write: { _serverId: "server-1", execute },
    } as any);

    const result = await wrapped.write.execute!({}, {} as any);
    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      mcpjamPolicyBlock: true,
      content: [
        {
          type: "text",
          text: expect.stringContaining("destructiveDefaultDeny"),
        },
      ],
    });
    expect(result).not.toHaveProperty("isError");
    expect(gate.blocks).toHaveLength(1);
    expect(gate.blocks[0]).toMatchObject({
      toolName: "write",
      reason: "destructiveDefaultDeny",
      classification: "destructive",
    });
    expect(gate.blocks[0]?.at).toEqual(expect.any(Number));
  });

  it("records blocks when wrap is detached from the gate", async () => {
    const gate = createToolPolicyGate({
      policy: { mode: "default" },
      annotations: new Map([
        [toolAnnotationsKey("server-1", "write"), { destructiveHint: true }],
      ]),
    });
    const { wrap } = gate;
    const wrapped = wrap({
      write: { _serverId: "server-1" },
    } as any);

    await wrapped.write.execute!({}, { toolCallId: "detached-call" } as any);

    expect(gate.blocks).toMatchObject([
      { toolName: "write", toolCallId: "detached-call" },
    ]);
    expect(gate.blockedToolCallIds()).toEqual(new Set(["detached-call"]));
  });

  it("leaves internal tools subject to explicit deny but not mode-derived rules", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [] });
    const gate = createToolPolicyGate({
      policy: { mode: "readOnly" },
      annotations: new Map(),
    });
    const wrapped = gate.wrap({
      bash: { execute },
      deniedInternal: { execute },
    } as any);

    await wrapped.bash.execute!({}, {} as any);
    expect(execute).toHaveBeenCalledTimes(1);
    const denyGate = createToolPolicyGate({
      policy: { mode: "readOnly", deny: ["deniedInternal"] },
      annotations: new Map(),
    });
    const denied = denyGate.wrap({ deniedInternal: { execute } } as any);
    await denied.deniedInternal.execute!({}, {} as any);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(denyGate.blocks).toHaveLength(1);
  });

  it("allows an explicitly allowed destructive MCP tool", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [] });
    const gate = createToolPolicyGate({
      policy: { mode: "default", allow: ["write"] },
      annotations: new Map([
        [toolAnnotationsKey("server-1", "write"), { destructiveHint: true }],
      ]),
    });
    const wrapped = gate.wrap({
      write: { _serverId: "server-1", execute },
    } as any);

    await wrapped.write.execute!({}, {} as any);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(gate.blocks).toHaveLength(0);
  });

  it("blocks an unannotated MCP tool in readOnly mode", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [] });
    const gate = createToolPolicyGate({
      policy: { mode: "readOnly" },
      annotations: new Map(),
    });
    const wrapped = gate.wrap({
      unknown: { _serverId: "server-1", execute },
    } as any);

    const result = await wrapped.unknown.execute!({}, {} as any);
    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      mcpjamPolicyBlock: true,
      content: [
        {
          type: "text",
          text: expect.stringContaining("readOnlyModeUnclassified"),
        },
      ],
    });
    expect(gate.blocks).toHaveLength(1);
  });

  it("injects a block execute for denied tools without a local execute", async () => {
    const gate = createToolPolicyGate({
      policy: { mode: "default", deny: ["ui_save"] },
      annotations: new Map(),
    });
    const wrapped = gate.wrap({
      ui_save: { description: "client fulfilled tool" },
    } as any);

    const result = await wrapped.ui_save.execute!({}, {
      toolCallId: "blocked-ui-call",
    } as any);
    expect(result).toMatchObject({ mcpjamPolicyBlock: true });
    expect(gate.blocks).toMatchObject([
      { toolName: "ui_save", toolCallId: "blocked-ui-call" },
    ]);
  });

  it("refuses unmatched deny names and warns for unmatched allow names", () => {
    const denyPolicy = { mode: "default" as const, deny: ["missing"] };
    expect(() =>
      validateToolPolicyNames({
        policy: denyPolicy,
        availableToolNames: ["present"],
      })
    ).toThrow("Tool policy deny name(s) did not match any available tool");

    const allowPolicy = { mode: "default" as const, allow: ["missing"] };
    const allowGate = createToolPolicyGate({
      policy: allowPolicy,
      annotations: new Map(),
    });
    const warnings = validateToolPolicyNames({
      policy: allowPolicy,
      availableToolNames: ["present"],
    });
    expect(warnings).toEqual([
      "Tool policy allow name(s) did not match any available tool: missing",
    ]);
    allowGate.wrap({ present: {} } as any);
    expect(allowGate.warnings).toEqual([]);
  });

  it("warns instead of refusing names for conditionally injected tools", () => {
    expect(
      validateToolPolicyNames({
        policy: { mode: "default", deny: ["loadSkill"] },
        availableToolNames: [],
        deferredToolNames: ["loadSkill"],
      })
    ).toEqual([
      "Tool policy deny name(s) could not be resolved at run start: loadSkill",
    ]);
  });
});
