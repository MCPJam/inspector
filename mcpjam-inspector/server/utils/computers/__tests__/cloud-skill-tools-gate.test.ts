import { describe, it, expect, vi } from "vitest";

// Gate the engine signal: an MCPJam-provided model id reports true, BYOK false.
// Mirrors the real helper's provider-aware canonicalization: a BARE id only
// counts as MCPJam-provided when the provider is supplied (bare + provider →
// prefixed hosted id).
vi.mock("../../../services/hosted-model-catalog.js", () => ({
  isHostedCatalogModel: (id: string, provider?: string) =>
    id.startsWith("mcpjam/") || (provider === "mcpjam" && !id.includes("/")),
}));

import {
  resolveGuestCloudSkillScope,
  shouldEnableCloudSkillTools,
} from "../cloud-skill-tools";
import type { ExecutionScope } from "../../execution-scope.js";

const base = {
  isGuest: false,
  hasExecutionScope: false,
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

  it("disables for a guest whose turn carries no execution scope", () => {
    expect(shouldEnableCloudSkillTools({ ...base, isGuest: true })).toBe(false);
  });

  it("ENABLES for a guest whose turn carries an execution scope", () => {
    // COMP-38: the scope is what authorizes the scoped skill reads, so a guest
    // the backend granted one gets the tools those reads back.
    expect(
      shouldEnableCloudSkillTools({
        ...base,
        isGuest: true,
        hasExecutionScope: true,
      })
    ).toBe(true);
  });

  it("still disables a scoped guest on a real harness turn", () => {
    // The scope relaxes the guest gate, not the harness gate: a harness turn
    // delivers skills via the adapter, so the emulated tools stay off.
    expect(
      shouldEnableCloudSkillTools({
        ...base,
        isGuest: true,
        hasExecutionScope: true,
        harness: "claude-code",
        modelId: "mcpjam/claude",
      })
    ).toBe(false);
  });

  it("still disables a scoped guest with no project id", () => {
    expect(
      shouldEnableCloudSkillTools({
        ...base,
        isGuest: true,
        hasExecutionScope: true,
        hasProjectId: false,
      })
    ).toBe(false);
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

describe("resolveGuestCloudSkillScope", () => {
  const scope: ExecutionScope = {
    kind: "swarm",
    swarmId: "swarm_1",
    accessVersion: 2,
    projectId: "proj_1",
    workspaceId: "ws_1",
  };

  it("returns the scope for a guest turn that carries one", () => {
    expect(
      resolveGuestCloudSkillScope({ isGuest: true, executionScope: scope })
    ).toBe(scope);
  });

  it("returns undefined for a member, scope or not", () => {
    // A member's config carries a scope too, and the scoped query is
    // shared-only — it would drop their personal skills.
    expect(
      resolveGuestCloudSkillScope({ isGuest: false, executionScope: scope })
    ).toBeUndefined();
    expect(
      resolveGuestCloudSkillScope({ isGuest: false, executionScope: undefined })
    ).toBeUndefined();
  });

  it("normalizes a null/omitted scope to undefined so the gate and the reads agree", () => {
    // The gate reads `!== undefined`; a raw `null` from a malformed config would
    // have opened it while the reads fell back to the membership-only query.
    expect(
      resolveGuestCloudSkillScope({ isGuest: true, executionScope: null })
    ).toBeUndefined();
    expect(
      resolveGuestCloudSkillScope({ isGuest: true, executionScope: undefined })
    ).toBeUndefined();
    expect(
      shouldEnableCloudSkillTools({
        ...base,
        isGuest: true,
        hasExecutionScope:
          resolveGuestCloudSkillScope({
            isGuest: true,
            executionScope: null,
          }) !== undefined,
      })
    ).toBe(false);
  });
});
