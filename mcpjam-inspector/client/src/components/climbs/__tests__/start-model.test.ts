import { describe, expect, it } from "vitest";
import {
  agentPrompt,
  hasIssues,
  startIssues,
  startRequest,
  type StartDraft,
} from "../start-model";

const draft: StartDraft = {
  serverId: "srv_1",
  environmentIds: ["env_a", "env_b"],
  picker: "person",
  modelId: "",
  roundLimit: "10",
  creditLimit: "4,000",
};

describe("startIssues", () => {
  it("accepts the defaults", () => {
    expect(hasIssues(startIssues(draft, true))).toBe(false);
  });

  it("names each thing that is missing", () => {
    const issues = startIssues(
      { ...draft, serverId: "", environmentIds: [], roundLimit: "0", creditLimit: "lots" },
      true,
    );
    expect(Object.keys(issues).sort()).toEqual([
      "creditLimit",
      "environmentIds",
      "roundLimit",
      "serverId",
    ]);
  });

  it("asks for a model only when MCPJam picks", () => {
    expect(startIssues({ ...draft, picker: "mcpjam" }, true).modelId).toMatch(/model/i);
    expect(startIssues({ ...draft, picker: "mcpjam", modelId: "m" }, true).modelId).toBeUndefined();
    expect(startIssues({ ...draft, picker: "agent" }, true).modelId).toBeUndefined();
  });

  it("does not ask for environments the suite does not list", () => {
    expect(startIssues({ ...draft, environmentIds: [] }, false).environmentIds).toBeUndefined();
  });

  it("caps rounds at 100", () => {
    expect(startIssues({ ...draft, roundLimit: "101" }, true).roundLimit).toBeDefined();
    expect(startIssues({ ...draft, roundLimit: "100" }, true).roundLimit).toBeUndefined();
  });
});

describe("startRequest", () => {
  const context = { projectId: "p", suiteId: "s", allEnvironmentIds: ["env_a", "env_b"] };

  it("leaves the environments out when every one is chosen", () => {
    const request = startRequest(draft, context);
    expect(request).toMatchObject({ roundLimit: 10, creditLimit: 4000, picker: "person" });
    expect(request).not.toHaveProperty("environmentIds");
    expect(request).not.toHaveProperty("pickerModel");
  });

  it("sends the chosen subset, and the model when MCPJam picks", () => {
    const request = startRequest(
      { ...draft, environmentIds: ["env_b"], picker: "mcpjam", modelId: "anthropic/claude" },
      context,
    );
    expect(request.environmentIds).toEqual(["env_b"]);
    expect(request.picker).toBe("mcpjam");
    expect(request.pickerModel).toBe("anthropic/claude");
  });
});

describe("agentPrompt", () => {
  it("names the server, the suite, the skill, the environments and the limits", () => {
    const prompt = agentPrompt({
      serverName: "mcpjam-mcp",
      suiteName: "dogfood",
      environmentLabels: ["Claude Code · Sonnet", "MCPJam · Haiku"],
      roundLimit: "10",
      creditLimit: "4,000",
    });
    expect(prompt).toContain('climb mcpjam-mcp on the suite "dogfood"');
    expect(prompt).toContain('"climb-an-mcp-server"');
    expect(prompt).toContain("Environments: Claude Code · Sonnet, MCPJam · Haiku.");
    expect(prompt).toContain("Stop after 10 rounds or 4,000 credits.");
  });
});
