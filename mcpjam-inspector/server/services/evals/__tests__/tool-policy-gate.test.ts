import { describe, expect, it, vi } from "vitest";
import { createToolPolicyGate, toolAnnotationsKey } from "../tool-policy-gate";

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
});
