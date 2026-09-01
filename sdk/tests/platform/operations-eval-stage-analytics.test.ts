/**
 * The two stage-analytics operations, and the three absences they keep apart.
 *
 * Stage analytics was reachable from the web app and from nowhere else: the
 * client methods existed, the routes existed, and no `PlatformOperation`
 * wrapped either — so no MCP tool and no CLI command could ask a run how much
 * of it was measured. These two ops close that, and the whole risk of doing so
 * is in one place: a 404.
 *
 * THREE DIFFERENT FACTS ARRIVE AS 404, and none may impersonate another.
 *
 *   1. The RUN is not there (or not visible). A run-not-found error.
 *   2. The DEPLOYMENT does not serve the route. An explicit deployment error —
 *      never "unmeasured", because that would report every run on that
 *      deployment as never measured, which is a claim about our rollout dressed
 *      up as a claim about their evals. This is the dark-ship failure the web
 *      wrapper's own comment warns about.
 *   3. The run exists and has NO DOCUMENT. Only here is "unmeasured" honest,
 *      and it is permanent: there is no backfill.
 *
 * The run op fetches the run FIRST for exactly this reason. The API declines to
 * separate (1) from (3) on purpose — separating them server-side would leak the
 * existence of runs in projects the caller cannot see — so the separation has
 * to happen on this side of the boundary, where the caller's scope is already
 * resolved.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  getEvalRunStageAnalyticsOperation,
  listEvalSuiteStageAnalyticsOperation,
  PlatformApiClient,
  PlatformApiError,
} from "../../src/platform/index.js";
import type { PlatformEvalStageAnalytics } from "../../src/platform/types.js";

const GOLDEN = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../fixtures/stage-analytics-golden.json", import.meta.url)
    ),
    "utf8"
  )
) as PlatformEvalStageAnalytics;

const PROJECTS = [{ id: "project-1", name: "Acme", slug: "acme" }];
const SUITES = [
  { id: "suite-1", name: "Checkout", createdAt: 1, updatedAt: 2 },
];

/** A 404 the router emitted with no v1 envelope — i.e. the route is not there. */
function bareNotFound(): Response {
  return new Response("Not Found", { status: 404 });
}

/**
 * A 404 the ROUTE emitted, saying the resource is not there.
 *
 * TOP-LEVEL `code`, exactly as `v1ErrorBody` writes it — there is no `error`
 * wrapper. The shape is the whole test: an enveloped code makes
 * `PlatformApiError.codeSource` `"envelope"`, and that is the only thing that
 * separates this from the bare 404 above, because `STATUS_FALLBACK_CODES`
 * gives both of them `code: "NOT_FOUND"`.
 */
function envelopeNotFound(message: string): Response {
  return Response.json({ code: "NOT_FOUND", message }, { status: 404 });
}

function makeClient(
  options: {
    /** How the run-scoped analytics route answers. */
    runAnalytics?: "ok" | "envelope404" | "bare404" | "notImplemented";
    /** How the suite-scoped analytics route answers. */
    suiteAnalytics?: "ok" | "bare404" | "methodNotAllowed";
    /** Whether the RUN itself exists. */
    runExists?: boolean;
    nextCursor?: string;
  } = {}
) {
  const fetchMock = vi.fn(async (target: unknown) => {
    const url = new URL(String(target));
    if (url.pathname === "/api/v1/projects") {
      return Response.json({ items: PROJECTS });
    }
    if (url.pathname === "/api/v1/projects/project-1/eval-suites") {
      return Response.json({ items: SUITES });
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
      url.pathname ===
      "/api/v1/projects/project-1/eval-runs/run-1/stage-analytics"
    ) {
      switch (options.runAnalytics ?? "ok") {
        case "envelope404":
          return envelopeNotFound("No stage analytics for this run");
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
    if (
      url.pathname ===
      "/api/v1/projects/project-1/eval-suites/suite-1/stage-analytics"
    ) {
      switch (options.suiteAnalytics ?? "ok") {
        case "bare404":
          return bareNotFound();
        case "methodNotAllowed":
          return new Response("Method Not Allowed", { status: 405 });
        default:
          return Response.json({
            items: [GOLDEN],
            ...(options.nextCursor ? { nextCursor: options.nextCursor } : {}),
          });
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

describe("get_eval_run_stage_analytics", () => {
  it("returns the run's document verbatim, with the run it belongs to", async () => {
    const { client, fetchMock } = makeClient();
    const result = await getEvalRunStageAnalyticsOperation.execute(
      { project: "project-1", runId: "run-1" },
      { client }
    );
    expect(result.analyticsState).toBe("measured");
    // VERBATIM. Reshaping it here would create a second reading of the same
    // funnel, which is the thing the whole contract exists to prevent.
    expect(result.analytics).toEqual(GOLDEN);
    expect(result.runId).toBe("run-1");
    expect(result.suiteId).toBe("suite-1");
    expect(result.project.id).toBe("project-1");
    // The run is fetched FIRST, and that ordering is load-bearing below.
    expect(paths(fetchMock)).toContain(
      "/api/v1/projects/project-1/eval-runs/run-1"
    );
  });

  it("says UNMEASURED only after the run itself was retrieved", async () => {
    const { client, fetchMock } = makeClient({ runAnalytics: "envelope404" });
    const result = await getEvalRunStageAnalyticsOperation.execute(
      { project: "project-1", runId: "run-1" },
      { client }
    );
    expect(result.analyticsState).toBe("unmeasured");
    expect(result.analytics).toBeNull();
    // Still addressable: a reader told "unmeasured" should still be able to
    // open the run.
    expect(result.runId).toBe("run-1");
    expect(result.suiteId).toBe("suite-1");
    const order = paths(fetchMock);
    expect(
      order.indexOf("/api/v1/projects/project-1/eval-runs/run-1")
    ).toBeLessThan(
      order.indexOf(
        "/api/v1/projects/project-1/eval-runs/run-1/stage-analytics"
      )
    );
  });

  it("fails as RUN-NOT-FOUND when the run is not there", async () => {
    // Without the run fetch this would have come back as "unmeasured" — a
    // confident claim about a run that does not exist, indistinguishable from
    // a typo in the run id.
    const { client, fetchMock } = makeClient({ runExists: false });
    await expect(
      getEvalRunStageAnalyticsOperation.execute(
        { project: "project-1", runId: "run-1" },
        { client }
      )
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    // And it never even asked for the analytics.
    expect(paths(fetchMock)).not.toContain(
      "/api/v1/projects/project-1/eval-runs/run-1/stage-analytics"
    );
  });

  it("fails EXPLICITLY when the deployment does not serve the route", async () => {
    // The dark-ship failure mode: rendering this as "never measured" reports
    // every run on the deployment as unmeasured.
    for (const runAnalytics of ["bare404", "notImplemented"] as const) {
      const { client } = makeClient({ runAnalytics });
      const error = await getEvalRunStageAnalyticsOperation
        .execute({ project: "project-1", runId: "run-1" }, { client })
        .then(
          () => undefined,
          (thrown: unknown) => thrown
        );
      expect(error, runAnalytics).toBeInstanceOf(PlatformApiError);
      expect((error as PlatformApiError).code, runAnalytics).toBe(
        "FEATURE_NOT_SUPPORTED"
      );
      expect((error as PlatformApiError).message, runAnalytics).toContain(
        "does not serve eval stage analytics"
      );
      // Says out loud what it is not, because the two read identically on the
      // wire and only one of them is about the run.
      expect((error as PlatformApiError).message, runAnalytics).toContain(
        "not about the run"
      );
    }
  });

  it("is a read with no risk facet and an addressable permalink", async () => {
    expect(getEvalRunStageAnalyticsOperation.readOnly).toBe(true);
    // `risk` must stay undefined on a read: the MCP registrar derives its
    // "COSTS MONEY" warning from it, and the agent-op registry derives tier.
    expect(getEvalRunStageAnalyticsOperation.risk).toBeUndefined();
    expect(getEvalRunStageAnalyticsOperation.permalink.kind).toBe("derive");
  });
});

describe("list_eval_suite_stage_analytics", () => {
  it("lists one document per run and forwards the window", async () => {
    const { client, fetchMock } = makeClient({ nextCursor: "cursor-2" });
    const result = await listEvalSuiteStageAnalyticsOperation.execute(
      {
        project: "project-1",
        suite: "Checkout",
        from: 1_700_000_000_000,
        to: 1_700_600_000_000,
        limit: 5,
        cursor: "cursor-1",
      },
      { client }
    );
    expect(result.suite).toEqual({ id: "suite-1", name: "Checkout" });
    expect(result.items).toEqual([GOLDEN]);
    expect(result.nextCursor).toBe("cursor-2");
    const url = fetchMock.mock.calls
      .map(([target]) => new URL(String(target)))
      .find((candidate) => candidate.pathname.endsWith("/stage-analytics"))!;
    expect(url.searchParams.get("from")).toBe("1700000000000");
    expect(url.searchParams.get("to")).toBe("1700600000000");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("cursor")).toBe("cursor-1");
  });

  it("omits nextCursor on the last page rather than sending null", async () => {
    const { client } = makeClient();
    const result = await listEvalSuiteStageAnalyticsOperation.execute(
      { project: "project-1", suite: "suite-1" },
      { client }
    );
    expect("nextCursor" in result).toBe(false);
  });

  it("fails EXPLICITLY when the deployment does not serve the route", async () => {
    // The suite was already resolved by this point, so a 404 from the
    // analytics route cannot mean "no such suite" — and reporting it as an
    // empty listing would say this suite has no measured runs.
    for (const suiteAnalytics of ["bare404", "methodNotAllowed"] as const) {
      const { client } = makeClient({ suiteAnalytics });
      await expect(
        listEvalSuiteStageAnalyticsOperation.execute(
          { project: "project-1", suite: "suite-1" },
          { client }
        )
      ).rejects.toMatchObject({ code: "FEATURE_NOT_SUPPORTED" });
    }
  });

  it("narrows to one comparison group when asked", () => {
    // The description tells a reader to partition on `runGroupId` before
    // claiming any trend. Without a selector that instruction could only be
    // followed by fetching a mixed page and filtering it client-side.
    const { client, fetchMock } = makeClient();
    return listEvalSuiteStageAnalyticsOperation
      .execute(
        { project: "project-1", suite: "suite-1", runGroupId: "grp-7" },
        { client }
      )
      .then(() => {
        const url = fetchMock.mock.calls
          .map(([target]) => new URL(String(target)))
          .find((candidate) =>
            candidate.pathname.endsWith("/stage-analytics")
          )!;
        expect(url.searchParams.get("runGroupId")).toBe("grp-7");
      });
  });

  it("refuses an inverted window before it reaches the wire", async () => {
    // A guaranteed 400. Refused in `execute` rather than a schema refinement,
    // per the rule `operationInputError` states: a caller that invokes
    // `execute` directly never parses the input schema.
    const { client, fetchMock } = makeClient();
    await expect(
      listEvalSuiteStageAnalyticsOperation.execute(
        {
          project: "project-1",
          suite: "suite-1",
          from: 1_700_600_000_000,
          to: 1_700_000_000_000,
        },
        { client }
      )
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(
      fetchMock.mock.calls
        .map(([target]) => new URL(String(target)).pathname)
        .filter((path) => path.endsWith("/stage-analytics"))
    ).toEqual([]);
  });

  it("requires a project and a suite, and bounds the page size", () => {
    const schema = listEvalSuiteStageAnalyticsOperation.inputSchema;
    expect(schema.safeParse({ suite: "s" }).success).toBe(false);
    expect(schema.safeParse({ project: "p" }).success).toBe(false);
    expect(schema.safeParse({ project: "  ", suite: "s" }).success).toBe(false);
    expect(
      schema.safeParse({ project: "p", suite: "s", limit: 0 }).success
    ).toBe(false);
    expect(
      schema.safeParse({ project: "p", suite: "s", limit: 101 }).success
    ).toBe(false);
    // Epoch MILLISECONDS, and an ISO string is a different type entirely.
    expect(
      schema.safeParse({ project: "p", suite: "s", from: "2026-01-01" }).success
    ).toBe(false);
    expect(
      schema.safeParse({ project: "p", suite: "s", from: 1_700_000_000_000 })
        .success
    ).toBe(true);
  });

  it("is a read with no risk facet and an addressable permalink", () => {
    expect(listEvalSuiteStageAnalyticsOperation.readOnly).toBe(true);
    expect(listEvalSuiteStageAnalyticsOperation.risk).toBeUndefined();
    expect(listEvalSuiteStageAnalyticsOperation.permalink.kind).toBe("derive");
  });
});

describe("both descriptions carry the comparability contract", () => {
  it("says never to sum, and what a zero denominator means", () => {
    for (const operation of [
      getEvalRunStageAnalyticsOperation,
      listEvalSuiteStageAnalyticsOperation,
    ]) {
      const description = operation.description;
      expect(description, operation.name).toContain(
        "ZERO DENOMINATOR MEANS NOT MEASURED"
      );
      expect(description, operation.name).toContain("Never sum tallies ACROSS");
      expect(description, operation.name).toContain("Never merge documents");
      expect(description, operation.name).toContain("NO BACKFILL");
      // `integrity` is a bug report, not a population fact.
      expect(description, operation.name).toContain("IS A BUG REPORT");
      // The glossary is where the members are defined.
      expect(description, operation.name).toContain(
        "user-value-chain-glossary"
      );
      expect(description, operation.name).not.toContain("COSTS MONEY");
    }
  });

  it("names every parity field a trend has to partition on", () => {
    // A listing is a trend series rendered side by side, and drawing two
    // funnels beside each other IS the comparability claim.
    const description = listEvalSuiteStageAnalyticsOperation.description;
    for (const field of [
      "runGroupId",
      "configRevision",
      "caseSetFingerprint",
      "stageAnalyzerVersion",
      "measurementsSchemaVersion",
      "materializationState",
    ]) {
      expect(description, field).toContain(field);
    }
    // An ABSENT identity blocks comparability rather than being assumed
    // compatible — the half a naive `a === b` gets backwards.
    expect(description).toContain("BLOCKS comparability");
    expect(description).toContain("stageAnalyticsParityBlockers");
  });
});
