import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { EvalSuite, EvalSuiteRunListItem } from "@/components/evals/types";
import {
  buildEvalNavPageServices,
  EvalNavPageServicesProvider,
  useEvalNavPageServices,
  type EvalNavPageServiceDeps,
} from "../nav/eval-nav-page-services";

const suite = {
  _id: "s1",
  name: "Suite",
  hostAttachments: [],
} as unknown as EvalSuite;

function deps(
  over: Partial<EvalNavPageServiceDeps> = {},
): EvalNavPageServiceDeps {
  return {
    rerunWithQuota: vi.fn(async () => ({ runIds: ["r1", "r2"] })),
    deleteTestCasesBatch: vi.fn(async () => {}),
    handlers: {
      handleCancelRun: vi.fn(async () => {}),
      directDeleteRun: vi.fn(async () => {}),
      handleDuplicateSuite: vi.fn(),
      rerunningSuiteId: null,
      cancellingRunId: "c1",
      replayingRunId: "rp1",
      runningTestCaseId: "tc1",
    },
    canDeleteRuns: true,
    canDeleteArtifact: (createdBy) => createdBy === "me",
    evalRunsDisabledReason: null,
    isDirectGuest: false,
    projectServers: [],
    connectedServerNames: new Set(["a"]),
    openCreateSuite: vi.fn(),
    evalServer: vi.fn(),
    showQuickstart: true,
    quickstartRunning: false,
    runQuickstart: vi.fn(),
    launchSources: { projectId: "p1", environments: undefined, hosts: [] },
    ...over,
  };
}

describe("buildEvalNavPageServices", () => {
  it("runCase narrows the quota-guarded rerun to one case; runSuite does not", async () => {
    const d = deps();
    const services = buildEvalNavPageServices(d);
    await expect(
      services.runCase(suite, "tc9", { iterationOverride: 2 }),
    ).resolves.toEqual({ runIds: ["r1", "r2"] });
    expect(d.rerunWithQuota).toHaveBeenLastCalledWith(suite, {
      iterationOverride: 2,
      caseIds: ["tc9"],
    });
    await services.runSuite(suite, { iterationOverride: 3 });
    expect(d.rerunWithQuota).toHaveBeenLastCalledWith(suite, {
      iterationOverride: 3,
    });
  });

  it("deleteTestCase deletes one id; cancelRun forwards every id", async () => {
    const d = deps();
    const services = buildEvalNavPageServices(d);
    await services.deleteTestCase("tc1");
    expect(d.deleteTestCasesBatch).toHaveBeenCalledWith(["tc1"]);
    await services.cancelRun(["r1", "r2"]);
    expect(d.handlers.handleCancelRun).toHaveBeenCalledWith(["r1", "r2"]);
  });

  it("deleteRun is absent without the permission; canDeleteRun uses the artifact check", () => {
    expect(
      buildEvalNavPageServices(deps({ canDeleteRuns: false })).deleteRun,
    ).toBeUndefined();
    const services = buildEvalNavPageServices(deps());
    expect(services.deleteRun).toBeDefined();
    expect(
      services.canDeleteRun({ createdBy: "me" } as EvalSuiteRunListItem),
    ).toBe(true);
    expect(
      services.canDeleteRun({ createdBy: "you" } as EvalSuiteRunListItem),
    ).toBe(false);
  });

  it("openCreateSuite picks the handler by whether a server is passed", () => {
    const d = deps();
    const services = buildEvalNavPageServices(d);
    services.openCreateSuite();
    expect(d.openCreateSuite).toHaveBeenCalledTimes(1);
    services.openCreateSuite({ _id: "srv", name: "Excalidraw" } as never);
    expect(d.evalServer).toHaveBeenCalledWith({
      id: "srv",
      name: "Excalidraw",
    });
  });

  it("quickstart is null when it is not offered; state passes through", () => {
    expect(
      buildEvalNavPageServices(deps({ showQuickstart: false })).quickstart,
    ).toBeNull();
    const services = buildEvalNavPageServices(deps());
    expect(services.quickstart?.running).toBe(false);
    expect(services).toMatchObject({
      cancellingRunId: "c1",
      replayingRunId: "rp1",
      runningTestCaseId: "tc1",
      rerunningSuiteId: null,
      isDirectGuest: false,
    });
  });

  it("launchReview carries the suite and the disabled reason", () => {
    const review = buildEvalNavPageServices(
      deps({ evalRunsDisabledReason: "Out of runs." }),
    ).launchReview(suite);
    expect(review).toMatchObject({
      projectId: "p1",
      suite,
      disabledReason: "Out of runs.",
    });
  });

  it("ensureServersReady falls back to the connected set", async () => {
    const result = await buildEvalNavPageServices(deps()).ensureServersReady([
      "a",
      "b",
    ]);
    expect(result.readyServerNames).toEqual(["a"]);
    expect(result.missingServerNames).toEqual(["b"]);
  });
});

describe("useEvalNavPageServices", () => {
  it("throws outside the provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useEvalNavPageServices())).toThrow(
      /EvalNavPageServicesProvider/,
    );
  });

  it("returns the provided value", () => {
    const value = buildEvalNavPageServices(deps());
    const wrapper = ({ children }: { children: ReactNode }) => (
      <EvalNavPageServicesProvider value={value}>
        {children}
      </EvalNavPageServicesProvider>
    );
    const { result } = renderHook(() => useEvalNavPageServices(), { wrapper });
    expect(result.current).toBe(value);
  });
});
