/**
 * `get_eval_run_gate` keeps a missing run, a missing route, and a real
 * `not_configured` report apart. A 404 after the run was retrieved is
 * never proof the suite has no policy.
 */

import { describe, expect, it, vi } from "vitest";
import { suiteGatePolicyHash } from "../../src/contract/suite-gate.js";
import {
  getEvalRunGateOperation,
  PlatformApiClient,
  PlatformApiError,
} from "../../src/platform/index.js";

const PROJECTS = [{ id: "project-1", name: "Acme", slug: "acme" }];
const REPORT = {
  schemaVersion: 1 as const,
  evaluatorVersion: 1 as const,
  policy: {},
  policyHash: suiteGatePolicyHash({}),
  outcome: "not_configured" as const,
  conditions: [],
};

function bareNotFound(): Response {
  return new Response("Not Found", { status: 404 });
}

function envelopeNotFound(message: string): Response {
  return Response.json({ code: "NOT_FOUND", message }, { status: 404 });
}

function makeClient(
  options: {
    runExists?: boolean;
    gate?: "ok" | "envelope404" | "bare404" | "notImplemented";
  } = {}
) {
  const fetchMock = vi.fn(async (target: unknown) => {
    const url = new URL(String(target));
    if (url.pathname === "/api/v1/projects") {
      return Response.json({ items: PROJECTS });
    }
    if (url.pathname === "/api/v1/projects/project-1/eval-runs/run-1") {
      if (options.runExists === false) {
        return envelopeNotFound("Eval run not found");
      }
      return Response.json({
        id: "run-1",
        suiteId: "suite-1",
        runNumber: 1,
        status: "completed",
        result: "passed",
        summary: null,
        source: "api",
        notes: null,
        createdAt: 1,
        completedAt: 2,
      });
    }
    if (url.pathname === "/api/v1/projects/project-1/eval-runs/run-1/gate") {
      switch (options.gate ?? "ok") {
        case "envelope404":
          return envelopeNotFound("Eval run not found");
        case "bare404":
          return bareNotFound();
        case "notImplemented":
          return Response.json(
            { code: "FEATURE_NOT_SUPPORTED", message: "not built" },
            { status: 501 }
          );
        default:
          return Response.json(REPORT);
      }
    }
    return envelopeNotFound(url.pathname);
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.example.com/api/v1",
    getAuth: () => "sk_test",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client };
}

describe("get_eval_run_gate", () => {
  it("returns the report after the run is retrieved", async () => {
    const { client } = makeClient();
    const result = await getEvalRunGateOperation.execute(
      { project: "project-1", runId: "run-1" },
      { client }
    );
    expect(result.report.outcome).toBe("not_configured");
    expect(result.runId).toBe("run-1");
    expect(result.suiteId).toBe("suite-1");
  });

  it("fails as a run-not-found error when the run is missing", async () => {
    const { client } = makeClient({ runExists: false });
    await expect(
      getEvalRunGateOperation.execute(
        { project: "project-1", runId: "run-1" },
        { client }
      )
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("fails as a deployment error on a bare 404 after the run exists", async () => {
    const { client } = makeClient({ gate: "bare404" });
    await expect(
      getEvalRunGateOperation.execute(
        { project: "project-1", runId: "run-1" },
        { client }
      )
    ).rejects.toBeInstanceOf(PlatformApiError);
    await expect(
      getEvalRunGateOperation.execute(
        { project: "project-1", runId: "run-1" },
        { client }
      )
    ).rejects.toMatchObject({ code: "FEATURE_NOT_SUPPORTED", status: 501 });
  });

  it("fails as a deployment error on 501", async () => {
    const { client } = makeClient({ gate: "notImplemented" });
    await expect(
      getEvalRunGateOperation.execute(
        { project: "project-1", runId: "run-1" },
        { client }
      )
    ).rejects.toMatchObject({ code: "FEATURE_NOT_SUPPORTED", status: 501 });
  });

  it("does not invent not_configured from an enveloped 404", async () => {
    const { client } = makeClient({ gate: "envelope404" });
    await expect(
      getEvalRunGateOperation.execute(
        { project: "project-1", runId: "run-1" },
        { client }
      )
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });
});
