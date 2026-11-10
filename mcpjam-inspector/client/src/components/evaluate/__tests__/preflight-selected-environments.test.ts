import { renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  CHOOSE_ORG_JUDGE_MODEL,
  hasBlockingPreflight,
  scopePreflightToEnvironments,
  useSuiteRunPreflight,
} from "../suite-run-preflight";
import type { EvalSuite } from "../../evals/types";

// The org's Cursor key, as the run sheet reads it; the environment
// resolutions stay empty.
const cursorKey = vi.hoisted(() => ({ readiness: "missing" }));
// The org config the sheet reads: by default the key policy with one OpenAI
// connection.
const POLICY_ORG_CONFIG = vi.hoisted(() => ({
  aiKeyPolicy: { requireOrgKeys: true, revision: 1 } as
    { requireOrgKeys: boolean; revision: number } | undefined,
  providers: [
    {
      id: "openai",
      providerKey: "openai",
      enabled: true,
      hasSecret: true,
      policyEligibility: { eligible: true },
    },
  ],
}));
const orgConfig = vi.hoisted(() => ({ current: POLICY_ORG_CONFIG }));
afterEach(() => {
  cursorKey.readiness = "missing";
  orgConfig.current = POLICY_ORG_CONFIG;
});
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useQueries: (queries: Record<string, unknown>) =>
    "cursor" in queries ? { cursor: { readiness: cursorKey.readiness } } : {},
}));
vi.mock("@/state/app-state-context", () => ({
  useOptionalSharedAppState: () => undefined,
}));
vi.mock("@/state/server-actions-context", () => ({
  useServerActionsOptional: () => undefined,
}));
vi.mock("@/hooks/useProjects", () => ({
  shouldQueryProjectId: () => true,
  useProjectServers: () => ({ servers: [] }),
}));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));
vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({
    hosts: [
      { hostId: "codex", harness: "codex" },
      { hostId: "cursor", harness: "cursor" },
    ],
  }),
}));
vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: [] }),
}));
vi.mock("@/hooks/use-org-models-handoff", () => ({
  useOrgModelsHandoff: () => undefined,
}));
vi.mock("@/hooks/use-hosted-org-model-config", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/use-hosted-org-model-config")
  >()),
  useHostedOrgModelConfig: () => orgConfig.current,
}));

const suite: EvalSuite = {
  _id: "suite",
  createdBy: "user",
  name: "Suite",
  description: "",
  configRevision: "1",
  environment: { servers: [] },
  createdAt: 0,
  updatedAt: 0,
  environmentIds: ["supported", "unsupported"],
  judgeConfig: { goalCompletion: { enabled: false } },
};
const environments = [
  {
    environmentId: "supported",
    hostId: "codex",
    modelId: "openai/gpt-5",
    modelSelection: {
      modelId: "openai/gpt-5",
      source: "org",
      connectionRef: { kind: "orgProvider", id: "openai" },
    },
  },
  { environmentId: "unsupported", hostId: "cursor", modelId: "cursor/auto" },
];

it("blocks Cursor only when its environment is selected", () => {
  const { result } = renderHook(() =>
    useSuiteRunPreflight({
      projectId: "project",
      suite,
      cases: [],
      environments,
    }),
  );
  expect(hasBlockingPreflight(result.current)).toBe(true);
  expect(
    hasBlockingPreflight(
      scopePreflightToEnvironments(result.current, ["supported"]),
    ),
  ).toBe(false);
  const blocked = scopePreflightToEnvironments(result.current, ["unsupported"]);
  expect(hasBlockingPreflight(blocked)).toBe(true);
  expect(blocked.orgConfigProblems).toEqual([
    "Ask an org admin to add a Cursor key in Organization → AI providers.",
  ]);
});

it("lets Cursor through once the org's Cursor key is ready", () => {
  cursorKey.readiness = "ready";
  const { result } = renderHook(() =>
    useSuiteRunPreflight({
      projectId: "project",
      suite,
      cases: [],
      environments,
    }),
  );
  expect(hasBlockingPreflight(result.current)).toBe(false);
  expect(
    scopePreflightToEnvironments(result.current, ["unsupported"])
      .orgConfigProblems,
  ).toEqual([]);
});

it("retains the required judge problem after deselecting Cursor", () => {
  const { result } = renderHook(() =>
    useSuiteRunPreflight({
      projectId: "project",
      suite: { ...suite, judgeConfig: undefined },
      cases: [],
      environments,
    }),
  );
  const scoped = scopePreflightToEnvironments(result.current, ["supported"]);
  expect(scoped.orgConfigProblems).toEqual([CHOOSE_ORG_JUDGE_MODEL]);
  expect(hasBlockingPreflight(scoped)).toBe(true);
});

it("blocks an Azure model with no deployment only when its environment is selected, without the key policy", () => {
  orgConfig.current = {
    aiKeyPolicy: undefined,
    providers: [
      ...POLICY_ORG_CONFIG.providers,
      {
        id: "azure",
        providerKey: "azure",
        enabled: true,
        hasSecret: true,
        policyEligibility: { eligible: true },
      },
    ],
  };
  const { result } = renderHook(() =>
    useSuiteRunPreflight({
      projectId: "project",
      suite: { ...suite, environmentIds: ["supported", "azure"] },
      cases: [],
      environments: [
        environments[0]!,
        {
          environmentId: "azure",
          hostId: "codex",
          modelId: "azure/gpt-5.1",
          modelSelection: {
            modelId: "azure/gpt-5.1",
            source: "org",
            connectionRef: { kind: "orgProvider", id: "azure" },
          },
        },
      ],
    }),
  );
  expect(
    scopePreflightToEnvironments(result.current, ["azure"]).orgConfigProblems,
  ).toEqual([
    "azure/gpt-5.1 has no Azure deployment. Pick a deployment for it, or add one in Organization → AI providers.",
  ]);
  expect(
    hasBlockingPreflight(
      scopePreflightToEnvironments(result.current, ["supported"]),
    ),
  ).toBe(false);
});
