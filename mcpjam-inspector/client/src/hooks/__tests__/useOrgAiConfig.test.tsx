import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelSelection } from "@mcpjam/sdk/browser";

const state = vi.hoisted(() => ({
  queryValue: undefined as unknown,
  queryCalls: [] as Array<{ name: string; args: unknown }>,
  calls: [] as Array<{ name: string; args: unknown }>,
  results: {} as Record<string, unknown>,
  failures: {} as Record<string, unknown>,
  isAuthenticated: true,
  isUserReady: true,
}));

vi.mock("convex/react", () => {
  const call = (name: string) => async (args: unknown) => {
    state.calls.push({ name, args });
    if (state.failures[name]) throw state.failures[name];
    return state.results[name];
  };
  return {
    useConvexAuth: () => ({
      isAuthenticated: state.isAuthenticated,
      isLoading: false,
    }),
    useQuery: (name: string, args: unknown) => {
      state.queryCalls.push({ name, args });
      return args === "skip" ? undefined : state.queryValue;
    },
    useMutation: call,
    useAction: call,
  };
});

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => state.isUserReady,
}));

import { orgAiRoleSelectionKey, useOrgAiConfig } from "../useOrgAiConfig";

const SELECTION: ModelSelection = {
  modelId: "openai/gpt-5-mini",
  source: "org",
  connectionRef: { kind: "orgProvider", id: "conn_1" },
  nativeModelId: "gpt-5-mini",
  fallback: { provider: "none", model: "none" },
};

const CONFIG = {
  organizationId: "org-1",
  aiKeyPolicy: { requireOrgKeys: false, revision: 0 },
  aiModelRoles: { revision: 0 },
  aiModelRoleChecks: [],
  readiness: {
    requireOrgKeys: false,
    features: [],
    operations: [],
    eligibleConnectionIds: [],
  },
  canManage: true,
};

beforeEach(() => {
  state.queryValue = CONFIG;
  state.queryCalls = [];
  state.calls = [];
  state.results = {};
  state.failures = {};
  state.isAuthenticated = true;
  state.isUserReady = true;
});

describe("useOrgAiConfig", () => {
  it("reads the organization's AI config", () => {
    const { result } = renderHook(() => useOrgAiConfig("org-1"));

    expect(state.queryCalls.at(-1)).toEqual({
      name: "aiExecutionAdmission:getOrganizationAiConfig",
      args: { organizationId: "org-1" },
    });
    expect(result.current.config).toEqual(CONFIG);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.unsupported).toBe(false);
  });

  it("waits for auth and the user row before querying", () => {
    state.isUserReady = false;
    const { result } = renderHook(() => useOrgAiConfig("org-1"));

    expect(state.queryCalls.at(-1)?.args).toBe("skip");
    expect(result.current.config).toBeUndefined();
  });

  it("reports an incomplete config as unsupported rather than as off", () => {
    state.queryValue = { organizationId: "org-1", canManage: true };
    const { result } = renderHook(() => useOrgAiConfig("org-1"));

    expect(result.current.unsupported).toBe(true);
    expect(result.current.config).toBeUndefined();
  });

  it("sets the policy", async () => {
    state.results["organizations:setOrganizationRequireOrgKeys"] = {
      requireOrgKeys: true,
      revision: 1,
    };
    const { result } = renderHook(() => useOrgAiConfig("org-1"));

    await act(() => result.current.setRequireOrgKeys(true));

    expect(state.calls).toEqual([
      {
        name: "organizations:setOrganizationRequireOrgKeys",
        args: { organizationId: "org-1", enabled: true },
      },
    ]);
  });

  it("saves only the roles it is given and returns what changed", async () => {
    state.results["organizations:setOrganizationAiModelRoles"] = {
      revision: 2,
      changed: ["fast", "embedding"],
    };
    const { result } = renderHook(() => useOrgAiConfig("org-1"));

    let saved: unknown;
    await act(async () => {
      saved = await result.current.saveRoles({
        fast: SELECTION,
        embedding: null,
      });
    });

    expect(state.calls).toEqual([
      {
        name: "organizations:setOrganizationAiModelRoles",
        args: {
          organizationId: "org-1",
          roles: { fast: SELECTION, embedding: null },
        },
      },
    ]);
    expect(saved).toEqual({ revision: 2, changed: ["fast", "embedding"] });
  });

  it("surfaces the backend's ConvexError message when a save is refused", async () => {
    state.failures["organizations:setOrganizationAiModelRoles"] = Object.assign(
      new Error("[CONVEX M(x)] Server Error"),
      {
        data: {
          code: "org_keys_required",
          message: "Choose a model from an organization provider.",
        },
      },
    );
    const { result } = renderHook(() => useOrgAiConfig("org-1"));

    await act(async () => {
      await expect(
        result.current.saveRoles({ fast: SELECTION }),
      ).rejects.toThrow();
    });

    expect(result.current.error).toBe(
      "Choose a model from an organization provider.",
    );
    expect(result.current.testError).toBeNull();
  });

  it("tests the saved role, or a candidate before saving", async () => {
    state.results["organizationAiModels:testOrganizationModelRole"] = {
      role: "fast",
      outcome: "ok",
      checkedAt: 10,
    };
    const { result } = renderHook(() => useOrgAiConfig("org-1"));

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.testRole("fast");
    });
    await act(async () => {
      await result.current.testRole("fast", SELECTION);
    });

    expect(outcome).toEqual({ role: "fast", outcome: "ok", checkedAt: 10 });
    expect(state.calls).toEqual([
      {
        name: "organizationAiModels:testOrganizationModelRole",
        args: { organizationId: "org-1", role: "fast" },
      },
      {
        name: "organizationAiModels:testOrganizationModelRole",
        args: { organizationId: "org-1", role: "fast", selection: SELECTION },
      },
    ]);
  });

  it("keeps a failed test apart from save errors", async () => {
    state.failures["organizationAiModels:testOrganizationModelRole"] =
      new Error("Only organization owners and admins can test models.");
    const { result } = renderHook(() => useOrgAiConfig("org-1"));

    await act(async () => {
      await expect(result.current.testRole("smart")).rejects.toThrow();
    });

    expect(result.current.testError).toBe(
      "Only organization owners and admins can test models.",
    );
    expect(result.current.error).toBeNull();
  });
});

describe("orgAiRoleSelectionKey", () => {
  it("joins the connection, model and native id", () => {
    expect(orgAiRoleSelectionKey(SELECTION)).toBe(
      "conn_1|openai/gpt-5-mini|gpt-5-mini",
    );
    const { nativeModelId: _omit, ...withoutNative } = SELECTION;
    expect(orgAiRoleSelectionKey(withoutNative)).toBe(
      "conn_1|openai/gpt-5-mini|",
    );
  });
});
