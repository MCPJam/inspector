import { describe, expect, it, vi } from "vitest";
import {
  buildEvalRunFindingsOperation,
  cancelEvalRunInsightsOperation,
  requestEvalRunInsightsOperation,
  type PlatformApiClient,
} from "../../src/platform/index.js";

const PROJECT = {
  id: "project-1",
  name: "Demo Evals",
  organizationId: "org-1",
  updatedAt: 1,
};

/** A client that resolves one project and records each insights call. */
function stubClient() {
  const calls = {
    requestEvalRunInsights: vi.fn(async (params: Record<string, unknown>) => ({
      runId: params.runId,
      projectId: params.projectId,
      status: "pending",
    })),
    cancelEvalRunInsights: vi.fn(async (params: Record<string, unknown>) => ({
      runId: params.runId,
      projectId: params.projectId,
      canceled: true,
    })),
    buildEvalRunFindings: vi.fn(async (params: Record<string, unknown>) => ({
      runId: params.runId,
      projectId: params.projectId,
      status: "pending",
    })),
  };
  const client = {
    listProjects: async () => ({ items: [PROJECT] }),
    ...calls,
  } as unknown as PlatformApiClient;
  return { client, calls };
}

describe("eval run insights operations", () => {
  it("requests the analysis on the resolved project, forwarding force", async () => {
    const { client, calls } = stubClient();
    const result = await requestEvalRunInsightsOperation.execute(
      { project: "Demo Evals", runId: "run-1", force: true },
      { client }
    );
    expect(calls.requestEvalRunInsights).toHaveBeenCalledWith(
      { projectId: "project-1", runId: "run-1", force: true },
      expect.anything()
    );
    expect(result.request.status).toBe("pending");
    expect(result.project.id).toBe("project-1");
  });

  it("omits force when it is not asked for", async () => {
    const { client, calls } = stubClient();
    await requestEvalRunInsightsOperation.execute(
      { project: "Demo Evals", runId: "run-1" },
      { client }
    );
    expect(calls.requestEvalRunInsights.mock.calls[0]?.[0]).toEqual({
      projectId: "project-1",
      runId: "run-1",
    });
  });

  it("cancels the analysis", async () => {
    const { client, calls } = stubClient();
    const result = await cancelEvalRunInsightsOperation.execute(
      { project: "Demo Evals", runId: "run-1" },
      { client }
    );
    expect(calls.cancelEvalRunInsights).toHaveBeenCalledWith(
      { projectId: "project-1", runId: "run-1" },
      expect.anything()
    );
    expect(result.canceled.canceled).toBe(true);
  });

  it("builds findings, forwarding force", async () => {
    const { client, calls } = stubClient();
    const result = await buildEvalRunFindingsOperation.execute(
      { project: "Demo Evals", runId: "run-1", force: true },
      { client }
    );
    expect(calls.buildEvalRunFindings).toHaveBeenCalledWith(
      { projectId: "project-1", runId: "run-1", force: true },
      expect.anything()
    );
    expect(result.build.status).toBe("pending");
  });

  it("requires the run's project, like get_eval_run", () => {
    for (const operation of [
      requestEvalRunInsightsOperation,
      cancelEvalRunInsightsOperation,
      buildEvalRunFindingsOperation,
    ]) {
      expect(
        operation.inputSchema.safeParse({ runId: "run-1" }).success,
        operation.name
      ).toBe(false);
    }
  });

  it("refuses a non-boolean force", () => {
    expect(
      requestEvalRunInsightsOperation.inputSchema.safeParse({
        project: "p",
        runId: "r",
        force: "true",
      }).success
    ).toBe(false);
  });
});
