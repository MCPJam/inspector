import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveOrgModelConfig = vi.hoisted(() => vi.fn());
vi.mock("../org-model-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../org-model-config")>()),
  resolveOrgModelConfig,
}));

import { ownKeyTurnRefusal, type OwnKeyTurn } from "../own-key-turn-policy";

const none = { provider: "none", model: "none" } as const;

function turn(overrides: Partial<OwnKeyTurn> = {}): OwnKeyTurn {
  return {
    projectId: "project-1",
    selection: undefined,
    provider: "ollama",
    hasRequestKey: true,
    auth: { authHeader: "Bearer user-token" },
    ...overrides,
  };
}

const strict = { aiKeyPolicy: { requireOrgKeys: true }, providers: [] };

describe("ownKeyTurnRefusal", () => {
  beforeEach(() => {
    resolveOrgModelConfig.mockReset();
    vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses a local selection while the organization requires its own keys", async () => {
    resolveOrgModelConfig.mockResolvedValue(strict);
    const refusal = await ownKeyTurnRefusal(
      turn({
        selection: {
          modelId: "llama3",
          source: "local",
          connectionRef: { kind: "localProvider", providerKey: "ollama" },
          fallback: none,
        },
      }),
    );
    expect(refusal).toMatchObject({
      status: 403,
      details: { code: "org_keys_required" },
    });
    expect(resolveOrgModelConfig).toHaveBeenCalledWith(
      { projectId: "project-1" },
      { authHeader: "Bearer user-token" },
    );
  });

  it("refuses a turn with no saved selection, or a legacy one, the same way", async () => {
    resolveOrgModelConfig.mockResolvedValue(strict);
    for (const selection of [
      undefined,
      { source: "legacy", modelId: "llama3" } as const,
    ]) {
      expect(await ownKeyTurnRefusal(turn({ selection }))).toMatchObject({
        status: 403,
        details: { code: "org_keys_required" },
      });
    }
  });

  it("lets the turn run when the organization does not require its own keys", async () => {
    resolveOrgModelConfig.mockResolvedValue({
      aiKeyPolicy: { requireOrgKeys: false },
      providers: [],
    });
    expect(await ownKeyTurnRefusal(turn())).toBeUndefined();
  });

  it("reads nothing for a turn with no project or no backend", async () => {
    expect(
      await ownKeyTurnRefusal(turn({ projectId: undefined })),
    ).toBeUndefined();
    vi.stubEnv("CONVEX_HTTP_URL", "");
    expect(await ownKeyTurnRefusal(turn())).toBeUndefined();
    expect(resolveOrgModelConfig).not.toHaveBeenCalled();
  });

  it("refuses the turn, retryably, when the policy can't be read", async () => {
    resolveOrgModelConfig.mockRejectedValue(new Error("boom"));
    expect(await ownKeyTurnRefusal(turn())).toMatchObject({
      status: 503,
      details: { code: "ai_key_policy_unavailable", isRetryable: true },
    });
  });
});
