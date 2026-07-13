import { describe, expect, it } from "vitest";
import {
  mergeSystemToolsIntoAvailableTools,
  systemToolsToAssertable,
  type AssertableTool,
} from "../harness-system-tools";
import type { HarnessBuiltinToolInfo } from "@/hooks/useHarnessBuiltinTools";

const CATALOG: HarnessBuiltinToolInfo[] = [
  {
    key: "bash",
    name: "Bash",
    commonName: "bash",
    toolUseKind: "bash",
    description: "Execute a shell command",
    inputSchema: { type: "object", properties: { command: { type: "string" } } },
  },
  { key: "read", name: "Read", commonName: "read", toolUseKind: "readonly" },
  // Native-only tool: keyed by native name, no commonName.
  {
    key: "WebFetch",
    name: "WebFetch",
    description: "Fetch a URL and run a prompt against its content",
  },
];

const MCP_TOOLS: AssertableTool[] = [
  { name: "get_transactions", serverId: "srv_1" },
];

describe("systemToolsToAssertable", () => {
  it("emits the catalog KEY as the tool name — the wire name the bridge streams (toCommonName), never the display nativeName", () => {
    const names = systemToolsToAssertable(CATALOG).map((t) => t.name);
    expect(names).toEqual(["bash", "read", "WebFetch"]);
    expect(names).not.toContain("Bash");
  });

  it("marks entries as system, keeps input schemas, and brands the description", () => {
    const bash = systemToolsToAssertable(CATALOG).find(
      (t) => t.name === "bash",
    );
    expect(bash?.source).toBe("system");
    expect(bash?.inputSchema?.properties?.command).toEqual({ type: "string" });
    expect(bash?.description).toContain("System tool");
    expect(bash?.description).toContain("Execute a shell command");
    const read = systemToolsToAssertable(CATALOG).find(
      (t) => t.name === "read",
    );
    expect(read?.description).toBe("System tool (runs in harness)");
  });
});

describe("mergeSystemToolsIntoAvailableTools", () => {
  it("appends system tools after MCP tools", () => {
    const merged = mergeSystemToolsIntoAvailableTools(MCP_TOOLS, CATALOG);
    expect(merged.map((t) => t.name)).toEqual([
      "get_transactions",
      "bash",
      "read",
      "WebFetch",
    ]);
  });

  it("returns the input list untouched for an empty catalog (non-harness suite)", () => {
    expect(mergeSystemToolsIntoAvailableTools(MCP_TOOLS, [])).toBe(MCP_TOOLS);
  });

  it("drops a system tool whose name collides with an MCP tool — the name-based matcher couldn't tell them apart", () => {
    const merged = mergeSystemToolsIntoAvailableTools(
      [{ name: "bash", serverId: "srv_1" }],
      CATALOG,
    );
    expect(merged.filter((t) => t.name === "bash")).toHaveLength(1);
    expect(merged.find((t) => t.name === "bash")?.source).toBeUndefined();
  });
});
