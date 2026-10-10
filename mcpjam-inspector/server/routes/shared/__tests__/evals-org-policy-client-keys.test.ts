import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveOrgModelConfig = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/org-model-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/org-model-config")>()),
  resolveOrgModelConfig,
}));

import { orgPolicyConfigForClientKeys } from "../evals";
import { resolveEvalSelectionRoute } from "../../../services/evals-runner";
import { ModelResolutionRefusalError } from "../../../utils/model-resolution-local";
import { WebRouteError } from "../../web/errors.js";
import { ServiceCredentialUnavailableError } from "../../../services/service-credential.js";

const target = { projectId: "project_local_keys" };
const auth = { bearerToken: "tok" };

describe("orgPolicyConfigForClientKeys", () => {
  beforeEach(() => {
    resolveOrgModelConfig.mockReset();
    vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("carries the org config while the organization requires its own keys", async () => {
    const config = {
      aiKeyPolicy: { requireOrgKeys: true },
      providers: [
        {
          providerKey: "openai",
          exportDenied: true,
          exportDeniedCode: "org_keys_required",
        },
      ],
    };
    resolveOrgModelConfig.mockResolvedValue(config);

    expect(await orgPolicyConfigForClientKeys(target, auth)).toBe(config);
    expect(resolveOrgModelConfig).toHaveBeenCalledWith(target, auth);
  });

  it("leaves the request's own keys alone with the policy off", async () => {
    resolveOrgModelConfig.mockResolvedValue({
      aiKeyPolicy: { requireOrgKeys: false },
      providers: [{ providerKey: "openai", apiKey: "sk-org" }],
    });
    expect(await orgPolicyConfigForClientKeys(target, auth)).toBeUndefined();

    resolveOrgModelConfig.mockResolvedValue({ providers: [] });
    expect(await orgPolicyConfigForClientKeys(target, auth)).toBeUndefined();
  });

  it("refuses the run, retryably, when the policy read fails", async () => {
    resolveOrgModelConfig.mockRejectedValue(new Error("boom"));
    const error = await orgPolicyConfigForClientKeys(target, auth).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(WebRouteError);
    expect(error).toMatchObject({
      status: 503,
      details: { code: "ai_policy_unavailable", isRetryable: true },
    });
  });

  it("runs as before when the build cannot reach the organization's config", async () => {
    resolveOrgModelConfig.mockRejectedValue(
      new ServiceCredentialUnavailableError("org-model-config"),
    );
    expect(await orgPolicyConfigForClientKeys(target, auth)).toBeUndefined();

    vi.stubEnv("CONVEX_HTTP_URL", "");
    resolveOrgModelConfig.mockClear();
    expect(await orgPolicyConfigForClientKeys(target, auth)).toBeUndefined();
    expect(resolveOrgModelConfig).not.toHaveBeenCalled();
  });

  it("the config it carries refuses a saved local selection on the request's key", async () => {
    resolveOrgModelConfig.mockResolvedValue({
      aiKeyPolicy: { requireOrgKeys: true },
      providers: [],
    });
    const orgModelConfig = await orgPolicyConfigForClientKeys(target, auth);

    const refuse = () =>
      resolveEvalSelectionRoute({
        test: {
          title: "t",
          query: "q",
          runs: 1,
          model: "gpt-5-mini",
          provider: "openai",
          expectedToolCalls: [],
        } as never,
        selection: {
          modelId: "openai/gpt-5-mini",
          source: "local",
          connectionRef: { kind: "localProvider", providerKey: "openai" },
          nativeModelId: "gpt-5-mini",
          fallback: { provider: "none", model: "none" },
        } as never,
        modelApiKeys: { openai: "sk-personal" },
        orgModelConfig,
        orgModelConfigTarget: target,
      });
    expect(refuse).toThrow(ModelResolutionRefusalError);
    try {
      refuse();
    } catch (error) {
      expect((error as ModelResolutionRefusalError).code).toBe(
        "org_keys_required",
      );
    }
  });
});
