import { describe, expect, it } from "vitest";
import { HARNESS_IDS } from "@mcpjam/sdk/host-config/internal";
import { HARNESS_DESCRIPTORS, LOCAL_HARNESS_IDS, usesMcpjamClient } from "../harness-descriptors";
import { HARNESS_MCP_DELIVERY } from "../harness-mcp-delivery";
import { HARNESS_PINNED_VERSIONS, HARNESS_ORG_UPSTREAM } from "../harness-model-support";

describe("harness descriptors", () => {
  it("covers every SDK id and derives the existing runtime maps", () => {
    expect(Object.keys(HARNESS_DESCRIPTORS).sort()).toEqual([...HARNESS_IDS].sort());
    expect(HARNESS_MCP_DELIVERY).toEqual({ "claude-code": "harness", codex: "mcpjam", cursor: "harness" });
    expect(HARNESS_PINNED_VERSIONS).toEqual({ "claude-code": "2.1.245", codex: "0.163.0", cursor: "2026.10.01-e373342" });
    expect(HARNESS_ORG_UPSTREAM.cursor).toBeNull();
    expect(LOCAL_HARNESS_IDS).toEqual(["claude-code", "codex"]);
  });
  it("grants MCPJam extensions by client ownership", () => {
    expect(usesMcpjamClient({})).toBe(true);
    expect(usesMcpjamClient({ harness: "claude-code" })).toBe(false);
    expect(usesMcpjamClient({ harness: "codex" })).toBe(true);
    expect(usesMcpjamClient({ agentLoop: "claude-code" })).toBe(true);
    expect(usesMcpjamClient({ agentLoop: "unknown" })).toBe(false);
    expect(usesMcpjamClient({ agentLoop: "codex", harness: "codex" })).toBe(false);
  });
});
