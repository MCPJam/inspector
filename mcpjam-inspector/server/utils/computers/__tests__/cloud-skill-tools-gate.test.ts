import { describe, it, expect, vi } from "vitest";

// Gate the engine signal: an MCPJam-provided model id reports true, BYOK false.
vi.mock("@/shared/types", () => ({
  isMCPJamProvidedModel: (id: string) => id.startsWith("mcpjam/"),
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
});
