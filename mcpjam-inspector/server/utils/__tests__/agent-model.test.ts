import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { resolveConfig } = vi.hoisted(() => ({ resolveConfig: vi.fn() }));
vi.mock("../org-model-config", async (original) => ({
  ...(await original<typeof import("../org-model-config")>()),
  resolveOrgModelConfig: resolveConfig,
}));
import { resolveAgentModel } from "../agent-model";
import { MCPJAM_AGENT_MODEL } from "@/shared/mcpjam-agent-model";

const selection = {
  source: "org",
  modelId: "openai/gpt-6-astra",
  nativeModelId: "gpt-6-astra",
  connectionRef: { kind: "orgProvider", id: "org-connection" },
  fallback: { provider: "none", model: "none" },
};
const args = {
  projectId: "project-1",
  authHeader: "Bearer user-token",
  isGuest: false,
};
beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://example.convex.site");
  resolveConfig.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("the server-selected Ask MCPJam model", () => {
  it("uses the strict organization's default, without a platform billing claim", async () => {
    resolveConfig.mockResolvedValue({
      providers: [],
      aiKeyPolicy: { requireOrgKeys: true },
      defaultModel: selection,
    });
    const resolved = await resolveAgentModel(args);
    expect(resolveConfig).toHaveBeenCalledWith(
      { projectId: args.projectId },
      { authHeader: args.authHeader },
    );
    expect(resolved.routingSelection).toEqual(selection);
    expect(resolved.modelDefinition).toMatchObject({
      id: selection.modelId,
      hosted: false,
    });
    expect(resolved.billingFeature).toBeUndefined();
  });

  it("keeps the fixed platform-paid model for policy-off organizations", async () => {
    resolveConfig.mockResolvedValue({ providers: [], defaultModel: selection });
    const resolved = await resolveAgentModel(args);
    expect(resolved.modelDefinition.id).toBe(MCPJAM_AGENT_MODEL);
    expect(resolved.billingFeature).toBe("mcpjam_agent");
  });

  it("fails closed when a strict org has no valid org model", async () => {
    for (const defaultModel of [
      undefined,
      { ...selection, source: "hosted" },
    ]) {
      resolveConfig.mockResolvedValue({
        providers: [],
        aiKeyPolicy: { requireOrgKeys: true },
        defaultModel,
      });
      await expect(resolveAgentModel(args)).rejects.toMatchObject({
        status: 422,
        details: { code: "org_model_unconfigured" },
      });
    }
  });

  it("does not fall back to a platform model when the policy cannot be read", async () => {
    resolveConfig.mockRejectedValue(new Error("Policy unavailable"));
    await expect(resolveAgentModel(args)).rejects.toThrow("Policy unavailable");
  });

  it("leaves guest routing unchanged", async () => {
    const resolved = await resolveAgentModel({ ...args, isGuest: true });
    expect(resolved.modelDefinition.id).toBe(MCPJAM_AGENT_MODEL);
    expect(resolved.billingFeature).toBeUndefined();
    expect(resolveConfig).not.toHaveBeenCalled();
  });
});
