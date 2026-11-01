import { describe, expect, it } from "vitest";
import { evalTraceSpanZ } from "../eval-trace";
import { harnessToolOrigin, toolOrigin } from "../tool-origin";
import { getHarnessAdapter } from "../../server/utils/harness/registry";

describe("harness origin survives ingestion", () => {
  it("recognizes Claude's actual native ToolSearch without relabelling an MCP tool", () => {
    const nativeTools = getHarnessAdapter("claude-code").listBuiltinTools();
    const call = {
      rawToolName: "ToolSearch", toolName: "ToolSearch",
      hostTools: {}, nativeTools,
    };
    expect(harnessToolOrigin(call)).toBe("native");
    expect(harnessToolOrigin({ ...call, serverId: "server" })).toBe("mcp");
  });
  it.each([
    ["Bash", "bash", undefined, "native"],
    ["Bash", "bash", "server", "mcp"],
    ["Bash", "bash_extra", undefined, "unknown"],
    ["Read", "read", undefined, "native"],
  ] as const)("matches runtime %s to trace %s without losing MCP precedence", (key, name, serverId, expected) => {
    expect(harnessToolOrigin({
      rawToolName: key, toolName: name, serverId,
      nativeTools: [{ key }], hostTools: {},
    })).toBe(expected);
  });
  it.each([
    ["bash", undefined, "native"],
    ["bash", "server", "mcp"],
    ["mcp__missing__bash", undefined, "mcp"],
    ["mystery", undefined, "unknown"],
    ["web_search", undefined, "builtin"],
  ] as const)(
    "attributes %s with server %s as %s",
    (name, serverId, expected) => {
      const origin = harnessToolOrigin({
        rawToolName: name,
        toolName: name,
        serverId,
        nativeTools: [{ key: "bash" }],
        hostTools: { web_search: { _toolOrigin: "builtin" } },
      });
      const parsed = evalTraceSpanZ.parse({
        id: "t1",
        name,
        category: "tool",
        startMs: 0,
        endMs: 1,
        toolName: name,
        toolOrigin: origin,
      });
      expect(parsed.toolOrigin).toBe(expected);
    },
  );
  it("does not infer a builtin from the absence of a server", () => {
    expect(toolOrigin("bash")).toBe("unknown");
    expect(
      toolOrigin("bash", { _toolOrigin: "builtin", _serverId: "server" }),
    ).toBe("mcp");
    expect(
      evalTraceSpanZ.safeParse({
        id: "t",
        name: "t",
        category: "tool",
        startMs: 0,
        endMs: 1,
        toolOrigin: "made-up",
      }).success,
    ).toBe(false);
  });
});
