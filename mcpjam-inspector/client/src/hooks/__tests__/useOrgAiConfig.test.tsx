import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  };
});

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => state.isUserReady,
}));

import { useOrgAiConfig } from "../useOrgAiConfig";

const CONFIG = {
  organizationId: "org-1",
  aiKeyPolicy: { requireOrgKeys: false, revision: 0 },
  readiness: {
    requireOrgKeys: false,
    features: [],
    operations: [],
    eligibleConnectionIds: [],
  },
  canEnable: true,
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
    expect(result.current.isLoading).toBe(true);
  });

  it("reports an incomplete config as unsupported rather than as off", () => {
    state.queryValue = { organizationId: "org-1", canManage: true };
    const { result } = renderHook(() => useOrgAiConfig("org-1"));

    expect(result.current.unsupported).toBe(true);
    expect(result.current.config).toBeUndefined();
  });

  it.each([
    ["canEnable", { canEnable: undefined }],
    ["canManage", { canManage: undefined }],
    ["the policy", { aiKeyPolicy: { revision: 0 } }],
    ["readiness", { readiness: undefined }],
  ])(
    "reports a config without %s as unsupported",
    (_label, overrides: Record<string, unknown>) => {
      state.queryValue = { ...CONFIG, ...overrides };
      const { result } = renderHook(() => useOrgAiConfig("org-1"));

      expect(result.current.unsupported).toBe(true);
      expect(result.current.config).toBeUndefined();
    },
  );

  it("reads coverage from `readiness`, never from the provider list's `aiReadiness`", () => {
    const { readiness, ...withoutReadiness } = CONFIG;
    state.queryValue = { ...withoutReadiness, aiReadiness: readiness };
    const { result } = renderHook(() => useOrgAiConfig("org-1"));

    expect(result.current.unsupported).toBe(true);
  });

  it("treats a missing operations list as empty", () => {
    state.queryValue = {
      ...CONFIG,
      readiness: { ...CONFIG.readiness, operations: undefined },
    };
    const { result } = renderHook(() => useOrgAiConfig("org-1"));

    expect(result.current.unsupported).toBe(false);
    expect(result.current.config?.readiness.operations).toEqual([]);
  });

  it("passes a missing organization through as null", () => {
    state.queryValue = null;
    const { result } = renderHook(() => useOrgAiConfig("org-1"));

    expect(result.current.config).toBeNull();
    expect(result.current.unsupported).toBe(false);
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

  it("surfaces the backend's message when turning it on needs Enterprise", async () => {
    state.failures["organizations:setOrganizationRequireOrgKeys"] =
      Object.assign(new Error("[CONVEX M(x)] Server Error"), {
        data: {
          code: "enterprise_required",
          message:
            "Use your keys for all AI features is available on Enterprise plans.",
        },
      });
    const { result } = renderHook(() => useOrgAiConfig("org-1"));

    await act(async () => {
      await expect(result.current.setRequireOrgKeys(true)).rejects.toThrow();
    });

    expect(result.current.error).toBe(
      "Use your keys for all AI features is available on Enterprise plans.",
    );
  });
});
