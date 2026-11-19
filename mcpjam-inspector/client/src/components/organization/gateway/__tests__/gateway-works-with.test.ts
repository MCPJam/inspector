import { describe, expect, it } from "vitest";
import type { GatewayApi, GatewayModel } from "@/shared/gateway-connection";
import {
  blockedLabel,
  gatewayApiUsedBy,
  gatewayWorksWith,
  providerAttention,
} from "../gateway-works-with";

const MAPPED: GatewayModel[] = [
  { nativeModelId: "claude-sonnet-4.5", modelId: "anthropic/claude-sonnet-4.5" },
  { nativeModelId: "claude-haiku-4.5", modelId: "anthropic/claude-haiku-4.5" },
  { nativeModelId: "gpt-5.5", modelId: "openai/gpt-5.5" },
];
const ALL: GatewayApi[] = ["chatCompletions", "responses", "anthropicMessages"];

function rows(
  apis: GatewayApi[],
  overrides: Partial<Parameters<typeof gatewayWorksWith>[0]> = {},
) {
  return Object.fromEntries(
    gatewayWorksWith({
      apis,
      runtimeLocation: "cloud",
      models: MAPPED,
      requireOrgKeys: false,
      ...overrides,
    }).map((row) => [row.id, row]),
  );
}

describe("gatewayWorksWith", () => {
  it("lists every feature and harness client, Cursor last and never ready", () => {
    const list = gatewayWorksWith({ apis: ALL, runtimeLocation: "cloud", models: MAPPED, requireOrgKeys: false });
    expect(list.map((row) => row.id)).toEqual([
      "chat",
      "evals",
      "judges",
      "claude-code",
      "codex",
      "copilot-cli",
      "opencode",
      "cursor",
    ]);
    expect(list.at(-1)).toMatchObject({ ready: false, reason: expect.stringContaining("own account") });
  });

  it("is ready for chat, evals, judges and every harness with an org path on a full gateway", () => {
    const all = rows(ALL);
    for (const id of ["chat", "evals", "judges", "claude-code", "codex", "copilot-cli", "opencode"]) {
      expect(all[id]).toMatchObject({ ready: true });
    }
  });

  it("needs the one model OpenCode is verified on mapped", () => {
    const sonnetOnly = rows(ALL, { models: [MAPPED[0]!] });
    expect(sonnetOnly["claude-code"]).toMatchObject({ ready: true });
    expect(sonnetOnly.opencode).toMatchObject({ ready: false, reason: expect.stringContaining("Map one under Models") });
  });

  it("marks Codex and Copilot CLI unavailable without Responses", () => {
    const partial = rows(["chatCompletions", "anthropicMessages"]);
    for (const id of ["codex", "copilot-cli"]) {
      expect(partial[id]).toEqual(
        expect.objectContaining({ ready: false, reason: "Needs Responses, which this provider doesn't serve." }),
      );
    }
    expect(partial["claude-code"]).toMatchObject({ ready: true });
  });

  it("marks Claude Code and OpenCode unavailable without Anthropic Messages", () => {
    const partial = rows(["chatCompletions", "responses"]);
    for (const id of ["claude-code", "opencode"]) {
      expect(partial[id]).toMatchObject({ ready: false, reason: "Needs Anthropic Messages, which this provider doesn't serve." });
    }
    expect(partial.codex).toMatchObject({ ready: true });
  });

  it("needs a mapped model the harness is verified on", () => {
    const unmapped = rows(ALL, { models: [{ nativeModelId: "claude-sonnet-4.5" }] });
    expect(unmapped["claude-code"]).toMatchObject({ ready: false, reason: expect.stringContaining("Map one under Models") });
    // Copilot CLI is verified only on openai/gpt-5.5.
    const otherModel = rows(ALL, { models: [{ nativeModelId: "gpt-5", modelId: "openai/gpt-5" }] });
    expect(otherModel.codex).toMatchObject({ ready: true });
    expect(otherModel["copilot-cli"]).toMatchObject({ ready: false });
  });

  it("needs a chat API for chat, evals and judges", () => {
    const responsesOnly = rows(["responses"]);
    for (const id of ["chat", "evals", "judges"]) {
      expect(responsesOnly[id]).toMatchObject({ ready: false, reason: "Needs Chat Completions or Anthropic Messages." });
    }
  });

  it("keeps an Inspector-run gateway to chat and evals, and off under the key policy", () => {
    const local = rows(ALL, { runtimeLocation: "local" });
    expect(local.chat).toMatchObject({ ready: true, reason: "Runs in each user's Inspector." });
    expect(local.evals).toMatchObject({ ready: true });
    for (const id of ["judges", "claude-code", "codex", "copilot-cli"]) {
      expect(local[id]).toMatchObject({ ready: false, reason: expect.stringContaining("MCPJam's servers") });
    }
    const underPolicy = rows(ALL, { runtimeLocation: "local", requireOrgKeys: true });
    expect(underPolicy.chat).toMatchObject({ ready: false, reason: expect.stringContaining("key policy") });
  });
});

describe("gatewayApiUsedBy", () => {
  it("names the harness clients that speak each API", () => {
    expect(gatewayApiUsedBy("responses")).toBe("Used by Codex and GitHub Copilot CLI.");
    expect(gatewayApiUsedBy("anthropicMessages")).toMatch(/^Used by Claude Code and OpenCode, /);
    expect(gatewayApiUsedBy("chatCompletions")).toMatch(/Playground chat/);
    expect(gatewayApiUsedBy("embeddings")).toBe("Used by session map embeddings.");
  });
});

describe("providerAttention", () => {
  const attention = (apis: GatewayApi[], models = MAPPED, runtimeLocation: "cloud" | "local" = "cloud") =>
    providerAttention({ apis, runtimeLocation, models, requireOrgKeys: false });

  it("flags only what a setting here can fix, never Cursor", () => {
    expect(attention(ALL).blocked).toEqual([]);
    const noResponses = attention(["chatCompletions", "anthropicMessages"]);
    expect(noResponses.blocked.map((row) => row.id)).toEqual(["codex", "copilot-cli"]);
    expect(blockedLabel(noResponses.blocked)).toBe("Codex and GitHub Copilot CLI unavailable");
    expect(noResponses.rows.find((row) => row.id === "cursor")?.ready).toBe(false);
  });

  it("counts unmapped models and names three or more features by number", () => {
    const unmapped = attention(["chatCompletions"], [...MAPPED, { nativeModelId: "house-model" }]);
    expect(unmapped.unmapped).toBe(1);
    expect(blockedLabel(unmapped.blocked)).toBe("4 features unavailable");
    expect(blockedLabel([])).toBeNull();
  });
});
