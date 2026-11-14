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
afterEach(() => {
  cursorKey.readiness = "missing";
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
  useHostedOrgModelConfig: () => ({
    aiKeyPolicy: { requireOrgKeys: true, revision: 1 },
    providers: [
      {
        id: "openai",
        providerKey: "openai",
        enabled: true,
        hasSecret: true,
        policyEligibility: { eligible: true },
      },
    ],
  }),
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
  expect(blocked.orgKeyProblems).toEqual([
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
      .orgKeyProblems,
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
  expect(scoped.orgKeyProblems).toEqual([CHOOSE_ORG_JUDGE_MODEL]);
  expect(hasBlockingPreflight(scoped)).toBe(true);
});
