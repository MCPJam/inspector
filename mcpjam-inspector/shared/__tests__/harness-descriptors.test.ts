import { describe, expect, it } from "vitest";
import { HARNESS_IDS } from "@mcpjam/sdk/host-config/internal";
import {
  HARNESS_DESCRIPTORS,
  HARNESS_SURFACES,
  LOCAL_HARNESS_IDS,
  effectiveHarnessId,
  harnessSurfaceOfSource,
  harnessSurfaceRefusal,
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
      opencode: "1.18.34",
    });
    expect(HARNESS_DESCRIPTORS.cursor.orgKeys).toBe(false);
    expect(HARNESS_DESCRIPTORS.opencode.orgKeys).toBe(true);
    expect(LOCAL_HARNESS_IDS).toEqual(["claude-code", "codex", "copilot-cli"]);
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
  it("enforces the model selected for a Cursor account", () => {
    expect(HARNESS_DESCRIPTORS.cursor.controls.modelId.enforced).toBe(true);
    expect(HARNESS_DESCRIPTORS.cursor.modelAccess).toBe("external-account");
  });
});

describe("harness surface support", () => {
  // Every runtime runs everywhere unless it declares otherwise, so this table
  // is the whole list of exceptions. Changing it is a product decision.
  it("declares only these exceptions", () => {
    const declared = HARNESS_IDS.flatMap((id) =>
      HARNESS_SURFACES.filter((surface) => harnessSurfaceRefusal(id, surface)).map(
        (surface) => `${id} ${surface}`,
      ),
    ).sort();
    expect(declared).toEqual([
      "cursor api",
      "cursor events",
      "cursor guests",
      "cursor local",
      "cursor user-testing",
      "opencode guests",
      "opencode local",
    ]);
  });
  it("names the surface each turn source runs on", () => {
    expect(
      ["scenario", "eval", "swarm", "event", "direct", undefined].map(harnessSurfaceOfSource),
    ).toEqual(["user-testing", "evals", "swarms", "events", undefined, undefined]);
  });
  it("derives the local runtimes from the exceptions", () => {
    expect(LOCAL_HARNESS_IDS).toEqual(
      HARNESS_IDS.filter((id) => !harnessSurfaceRefusal(id, "local")),
    );
  });
});
