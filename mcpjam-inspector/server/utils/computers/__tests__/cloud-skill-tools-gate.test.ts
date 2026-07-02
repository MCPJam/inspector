import { describe, it, expect, vi } from "vitest";

// Gate the engine signal: an MCPJam-provided model id reports true, BYOK false.
// Mirrors the real helper's provider-aware canonicalization: a BARE id only
// counts as MCPJam-provided when the provider is supplied (bare + provider →
// prefixed hosted id).
vi.mock("@/shared/types", () => ({
  isMCPJamProvidedModel: (id: string, provider?: string) =>
    id.startsWith("mcpjam/") || (provider === "mcpjam" && !id.includes("/")),
}));

import { shouldEnableCloudSkillTools } from "../cloud-skill-tools";

const base = {
  isGuest: false,
  harness: undefined as string | undefined,
  modelId: "mcpjam/claude",
  hasProjectId: true,
};

describe("shouldEnableCloudSkillTools", () => {
  it("enables for a signed-in member with a project (no harness)", () => {
    expect(shouldEnableCloudSkillTools(base)).toBe(true);
  });

  it("enables on a computer-less host (gate is membership, not computer)", () => {
    // No computer/host config involved — purely project membership.
    expect(shouldEnableCloudSkillTools({ ...base, harness: undefined })).toBe(
      true
    );
  });

  it("disables for a guest", () => {
    expect(shouldEnableCloudSkillTools({ ...base, isGuest: true })).toBe(false);
  });

  it("disables without a project id", () => {
    expect(shouldEnableCloudSkillTools({ ...base, hasProjectId: false })).toBe(
      false
    );
  });

  it("disables for a real harness turn (claude-code host + MCPJam model)", () => {
    expect(
      shouldEnableCloudSkillTools({
        ...base,
        harness: "claude-code",
        modelId: "mcpjam/claude",
      })
    ).toBe(false);
  });

  it("ENABLES for a BYOK model on a claude-code host (runs emulated, not harness)", () => {
    // The critical engine-vs-host-config case: the host declares the harness, but
    // a BYOK model runs the emulated path — skills tools must be wired.
    expect(
      shouldEnableCloudSkillTools({
        ...base,
        harness: "claude-code",
        modelId: "openai/gpt-5",
      })
    ).toBe(true);
  });

  it("disables for a BARE MCPJam id + provider on a harness host (provider-aware)", () => {
    // Regression: a provider-blind check mis-detected bare hosted ids as
    // non-MCPJam and advertised the emulated skill tools into a harness turn.
    expect(
      shouldEnableCloudSkillTools({
        ...base,
        harness: "claude-code",
        modelId: "bare-model",
        provider: "mcpjam",
      })
    ).toBe(false);
  });

  it("disables for ANY harness id, not just claude-code (codex host)", () => {
    // Codex runs a real harness too; emulated skill tools on that turn would
    // be a prompt/tool mismatch even though Codex delivers no skills itself.
    expect(
      shouldEnableCloudSkillTools({
        ...base,
        harness: "codex",
        modelId: "mcpjam/gpt-5",
      })
    ).toBe(false);
  });
});
