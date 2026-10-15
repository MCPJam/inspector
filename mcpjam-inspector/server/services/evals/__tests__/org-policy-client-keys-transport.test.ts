import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orgPolicyConfigForClientKeys } from "../org-policy-client-keys";
import { resolveEvalSelectionRoute } from "../../evals-runner";
import {
  buildLlmRuntimeConfigFromOrgConfig,
  buildModelApiKeysFromOrgConfig,
  orgRequiresOwnKeys,
  resolveOrgModelConfig,
  type ResolvedOrgModelConfig,
} from "../../../utils/org-model-config";
import { ModelResolutionRefusalError } from "../../../utils/model-resolution-local";

// Acceptance test at the transport: the backend's resolve endpoint is the
// only thing stubbed. Nothing in the org config resolver, its in-process
// cache or the eval runner is mocked, so this pins the user story end to
// end: an admin turns "Use your keys for all AI features" on while this
// process already holds the organization's policy-off answer, and the very
// next eval run that brings its own keys is refused instead of running on
// any key.

const target = { projectId: "project_org_keys_transport_flip" };
const auth = { bearerToken: "user-transport-flip" };

const POLICY_OFF_ANSWER = {
  ok: true,
  aiKeyPolicy: { requireOrgKeys: false },
  providers: [{ providerKey: "openai", apiKey: "sk-org-exported" }],
};

// A stray `apiKey` on the withheld row: whatever the body says, a row marked
// `exportDenied` must never hand this process a key.
const POLICY_ON_ANSWER = {
  ok: true,
  aiKeyPolicy: { requireOrgKeys: true },
  providers: [
    {
      providerKey: "openai",
      apiKey: "sk-should-never-leave-the-backend",
      exportDenied: true,
      exportDeniedCode: "org_keys_required",
    },
  ],
};

function runOnRequestKey(orgModelConfig: ResolvedOrgModelConfig | undefined) {
  return resolveEvalSelectionRoute({
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
}

describe("eval runs on the request's own keys when the policy turns on mid-process", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example/");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("re-reads the policy past the cache, exports no key and keeps the typed refusal", async () => {
    let requireOrgKeys = false;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        Response.json(requireOrgKeys ? POLICY_ON_ANSWER : POLICY_OFF_ANSWER),
      );

    // The process loads the policy-off answer: the org key is exported, and a
    // run on the request's own keys carries no org config and runs.
    const loaded = await resolveOrgModelConfig(target, auth);
    expect(orgRequiresOwnKeys(loaded)).toBe(false);
    expect(buildModelApiKeysFromOrgConfig(loaded)).toEqual({
      openai: "sk-org-exported",
    });
    expect(await orgPolicyConfigForClientKeys(target, auth)).toBeUndefined();
    expect(runOnRequestKey(undefined).rail).toBe("local");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // An admin turns the policy on, well inside the cache window. The next
    // run asks the backend again: a policy-off answer is never cached.
    requireOrgKeys = true;
    const orgModelConfig = await orgPolicyConfigForClientKeys(target, auth);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(orgRequiresOwnKeys(orgModelConfig)).toBe(true);

    // No credential leaves the config, by any export path.
    expect(orgModelConfig?.providers).toEqual([
      {
        providerKey: "openai",
        exportDenied: true,
        exportDeniedCode: "org_keys_required",
      },
    ]);
    expect(buildModelApiKeysFromOrgConfig(orgModelConfig!)).toEqual({});
    const runtime = buildLlmRuntimeConfigFromOrgConfig(orgModelConfig!);
    expect(runtime.modelApiKeys).toEqual({});
    expect(JSON.stringify(runtime)).not.toContain("sk-");

    // The run on the request's own key is refused with the typed code, not
    // run on that key and not turned into a generic failure.
    let refusal: unknown;
    try {
      runOnRequestKey(orgModelConfig);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ModelResolutionRefusalError);
    expect((refusal as ModelResolutionRefusalError).code).toBe(
      "org_keys_required",
    );

    // The withholding answer is the one that may be cached: a stale copy
    // only fails closed, and the next run is refused the same way.
    const again = await orgPolicyConfigForClientKeys(target, auth);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(buildModelApiKeysFromOrgConfig(again!)).toEqual({});
    expect(() => runOnRequestKey(again)).toThrow(ModelResolutionRefusalError);
  });
});
