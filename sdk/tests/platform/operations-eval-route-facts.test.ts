/**
 * `get_eval_run_route_facts`, and the three absences it keeps apart.
 *
 * Same 404 discrimination as stage analytics: the run is fetched first so
 * "not visible" cannot impersonate "unmeasured", and a bare 404 from an
 * undeployed route cannot impersonate either.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  getEvalRunRouteFactsOperation,
  PlatformApiClient,
  PlatformApiError,
} from "../../src/platform/index.js";
import type { PlatformEvalRouteFacts } from "../../src/platform/types.js";

const GOLDEN = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../fixtures/route-facts-golden.json", import.meta.url)
    ),
    "utf8"
  )
) as PlatformEvalRouteFacts;

const PROJECTS = [{ id: "project-1", name: "Acme", slug: "acme" }];

function bareNotFound(): Response {
  return new Response("Not Found", { status: 404 });
}

function envelopeNotFound(message: string): Response {
  return Response.json({ code: "NOT_FOUND", message }, { status: 404 });
}

function makeClient(
  options: {
    runFacts?: "ok" | "envelope404" | "bare404" | "notImplemented";
    runExists?: boolean;
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
        result: "failed",
        summary: null,
        source: "api",
        notes: null,
        createdAt: 1,
        completedAt: 2,
      });
    }
    if (
      url.pathname === "/api/v1/projects/project-1/eval-runs/run-1/route-facts"
    ) {
      switch (options.runFacts ?? "ok") {
        case "envelope404":
          return envelopeNotFound("Eval run route facts not found");
        case "bare404":
          return bareNotFound();
        case "notImplemented":
          return Response.json(
            { code: "FEATURE_NOT_SUPPORTED", message: "not built" },
            { status: 501 }
          );
        default:
          return Response.json(GOLDEN);
      }
    }
    return envelopeNotFound(url.pathname);
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.example.com/api/v1",
    getAuth: () => "sk_test",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, fetchMock };
}

const paths = (fetchMock: ReturnType<typeof vi.fn>): string[] =>
  fetchMock.mock.calls.map(([target]) => new URL(String(target)).pathname);

describe("get_eval_run_route_facts", () => {
  it("returns the run's document verbatim, with the run it belongs to", async () => {
    const { client, fetchMock } = makeClient();
    const result = await getEvalRunRouteFactsOperation.execute(
      { project: "project-1", runId: "run-1" },
      { client }
    );
    expect(result.routeFactsState).toBe("measured");
    expect(result.routeFacts).toEqual(GOLDEN);
    expect(result.runId).toBe("run-1");
    expect(result.suiteId).toBe("suite-1");
    expect(result.project.id).toBe("project-1");
    expect(paths(fetchMock)).toContain(
      "/api/v1/projects/project-1/eval-runs/run-1"
    );
  });

  it("says UNMEASURED only after the run itself was retrieved", async () => {
    const { client, fetchMock } = makeClient({ runFacts: "envelope404" });
    const result = await getEvalRunRouteFactsOperation.execute(
      { project: "project-1", runId: "run-1" },
      { client }
    );
    expect(result.routeFactsState).toBe("unmeasured");
    expect(result.routeFacts).toBeNull();
    expect(result.runId).toBe("run-1");
    expect(result.suiteId).toBe("suite-1");
    const order = paths(fetchMock);
    expect(
      order.indexOf("/api/v1/projects/project-1/eval-runs/run-1")
    ).toBeLessThan(
      order.indexOf("/api/v1/projects/project-1/eval-runs/run-1/route-facts")
    );
  });

  it("fails as RUN-NOT-FOUND when the run is not there", async () => {
    const { client, fetchMock } = makeClient({ runExists: false });
    await expect(
      getEvalRunRouteFactsOperation.execute(
        { project: "project-1", runId: "run-1" },
        { client }
      )
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(paths(fetchMock)).not.toContain(
      "/api/v1/projects/project-1/eval-runs/run-1/route-facts"
    );
  });

  it("fails EXPLICITLY when the deployment does not serve the route", async () => {
    for (const runFacts of ["bare404", "notImplemented"] as const) {
      const { client } = makeClient({ runFacts });
      const error = await getEvalRunRouteFactsOperation
        .execute({ project: "project-1", runId: "run-1" }, { client })
        .then(
          () => undefined,
          (thrown: unknown) => thrown
        );
      expect(error, runFacts).toBeInstanceOf(PlatformApiError);
      expect((error as PlatformApiError).code, runFacts).toBe(
        "FEATURE_NOT_SUPPORTED"
      );
      expect((error as PlatformApiError).message, runFacts).toContain(
        "does not serve eval run route facts"
      );
      expect((error as PlatformApiError).message, runFacts).toContain(
        "not about the run"
      );
    }
  });

  it("is a read with no risk facet and an addressable permalink", async () => {
    expect(getEvalRunRouteFactsOperation.readOnly).toBe(true);
    expect(getEvalRunRouteFactsOperation.risk).toBeUndefined();
    expect(getEvalRunRouteFactsOperation.permalink.kind).toBe("derive");
  });

  it("states the counting rules a reader must not invent", () => {
    expect(getEvalRunRouteFactsOperation.description).toContain("trial");
    expect(getEvalRunRouteFactsOperation.description).toContain(
      "one-to-one in-catalog"
    );
    expect(getEvalRunRouteFactsOperation.description).toContain("catalogState");
    expect(getEvalRunRouteFactsOperation.description).toContain("notMeasured");
    expect(getEvalRunRouteFactsOperation.description).toContain(
      "endedWithQuestion"
    );
    expect(getEvalRunRouteFactsOperation.description).toMatch(/report-only/i);
    expect(getEvalRunRouteFactsOperation.description).toContain(
      "never a verdict"
    );
  });
});
