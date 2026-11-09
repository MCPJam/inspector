import { describe, expect, it } from "vitest";
import type { GatewayApi, GatewayModel } from "@/shared/gateway-connection";
import { gatewayApiUsedBy, gatewayWorksWith } from "../gateway-works-with";

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

  it("is ready for chat, evals, judges, Claude Code, Codex and Copilot CLI on a full gateway", () => {
    const all = rows(ALL);
    for (const id of ["chat", "evals", "judges", "claude-code", "codex", "copilot-cli"]) {
      expect(all[id]).toMatchObject({ ready: true });
    }
    // OpenCode doesn't take organization keys yet.
    expect(all.opencode).toMatchObject({ ready: false, reason: "OpenCode doesn't run on organization connections yet." });
  });

  it("marks Codex and Copilot CLI unavailable without Responses", () => {
    const partial = rows(["chatCompletions", "anthropicMessages"]);
    for (const id of ["codex", "copilot-cli"]) {
      expect(partial[id]).toEqual(
        expect.objectContaining({ ready: false, reason: "Needs Responses, which this gateway doesn't serve." }),
      );
    }
    expect(partial["claude-code"]).toMatchObject({ ready: true });
  });

  it("marks Claude Code and OpenCode unavailable without Anthropic Messages", () => {
    const partial = rows(["chatCompletions", "responses"]);
    for (const id of ["claude-code", "opencode"]) {
      expect(partial[id]).toMatchObject({ ready: false, reason: "Needs Anthropic Messages, which this gateway doesn't serve." });
    }
    expect(partial.codex).toMatchObject({ ready: true });
  });

  it("needs a mapped model the harness is verified on", () => {
    const unmapped = rows(ALL, { models: [{ nativeModelId: "claude-sonnet-4.5" }] });
    expect(unmapped["claude-code"]).toMatchObject({ ready: false, reason: expect.stringContaining("Map a gateway model") });
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
