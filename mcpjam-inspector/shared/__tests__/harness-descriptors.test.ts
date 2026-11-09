import { describe, expect, it } from "vitest";
import { HARNESS_IDS } from "@mcpjam/sdk/host-config/internal";
import {
  HARNESS_DESCRIPTORS,
  LOCAL_HARNESS_IDS,
  effectiveHarnessId,
  harnessAccountChoosesModel,
  usesMcpjamClient,
} from "../harness-descriptors";
import { HARNESS_MCP_DELIVERY } from "../harness-mcp-delivery";
import { HARNESS_PINNED_VERSIONS } from "../harness-model-support";

describe("harness descriptors", () => {
  it("covers every SDK id and derives the existing runtime maps", () => {
    expect(Object.keys(HARNESS_DESCRIPTORS).sort()).toEqual([...HARNESS_IDS].sort());
    expect(HARNESS_MCP_DELIVERY).toEqual({
      "claude-code": "harness",
      codex: "mcpjam",
      cursor: "harness",
      "copilot-cli": "mcpjam",
      opencode: "mcpjam",
    });
    expect(HARNESS_PINNED_VERSIONS).toEqual({
      "claude-code": "2.1.290",
      codex: "0.163.0",
      cursor: "2026.11.05-86047df",
      "copilot-cli": "1.0.92",
      opencode: "1.18.23",
    });
    expect(HARNESS_DESCRIPTORS.cursor.orgKeys).toBe(false);
    expect(HARNESS_DESCRIPTORS.opencode.orgKeys).toBe(true);
    expect(LOCAL_HARNESS_IDS).toEqual(["claude-code", "codex"]);
  });
  it("grants MCPJam extensions by client ownership", () => {
    expect(usesMcpjamClient({})).toBe(true);
    expect(usesMcpjamClient({ harness: "claude-code" })).toBe(false);
    expect(usesMcpjamClient({ harness: "codex" })).toBe(true);
    expect(usesMcpjamClient({ harness: "opencode" })).toBe(true);
    expect(usesMcpjamClient({ agentLoop: "claude-code" })).toBe(true);
    expect(usesMcpjamClient({ agentLoop: "unknown" })).toBe(false);
    expect(usesMcpjamClient({ agentLoop: "codex", harness: "codex" })).toBe(false);
  });
  it("reads a client's effective loop the way the turn does", () => {
    expect(effectiveHarnessId(null)).toBeNull();
    expect(effectiveHarnessId({})).toBeNull();
    expect(effectiveHarnessId({ harness: "claude-code" })).toBe("claude-code");
    expect(effectiveHarnessId({ agentLoop: "codex" })).toBe("codex");
    expect(effectiveHarnessId({ agentLoop: "codex", harness: "claude-code" })).toBe("codex");
  });
  it("knows which harness's account picks the model", () => {
    for (const id of HARNESS_IDS) {
      expect(harnessAccountChoosesModel(id)).toBe(
        HARNESS_DESCRIPTORS[id].modelAccess === "external-account",
      );
    }
    expect(harnessAccountChoosesModel("cursor")).toBe(true);
    expect(harnessAccountChoosesModel(null)).toBe(false);
    expect(harnessAccountChoosesModel("constructor")).toBe(false);
  });
});
