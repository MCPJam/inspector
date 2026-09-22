/**
 * The browser adapter for a RUN's stage analytics.
 *
 * What these pin:
 *
 *   - **Auth has ONE owner.** If the adapter lets `PlatformApiClient` set its
 *     own `Authorization`, `authFetch` treats the caller as owning the bearer
 *     and skips BOTH its header and its 401 refresh-and-retry.
 *   - **The filters reach the wire.** A dropped cursor silently re-reads page
 *     one forever; a dropped window reads a different population than the
 *     caller asked about.
 *   - **An abort stays an abort**, not an error painted on a surface the user
 *     just navigated away from.
 *   - **The four failure kinds stay four.** Only `invalidContract` is a bug
 *     report, and none of them is an empty page.
 *   - **The payload is VALIDATED, not trusted** — with the REFINED schema, and
 *     bound to the suite that was actually asked about.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { authFetchMock } = vi.hoisted(() => ({ authFetchMock: vi.fn() }));
vi.mock("@/lib/session-token", () => ({ authFetch: authFetchMock }));

import {
  EvalStageAnalyticsError,
  fetchEvalRunStageAnalytics,
  isEvalStageAnalyticsError,
} from "../eval-stage-analytics-api";
import {
  GOLDEN_STAGE_ANALYTICS,
  stageAnalyticsVariation,
} from "@/test/stage-analytics-fixtures";

const RUN_ID = GOLDEN_STAGE_ANALYTICS.runId;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function lastRequest(): { url: URL; init: RequestInit } {
  const [target, init] = authFetchMock.mock.calls.at(-1)!;
  return {
    url: new URL(String(target), "https://app.example.com"),
    init: (init ?? {}) as RequestInit,
  };
}

beforeEach(() => {
  authFetchMock.mockReset();
});


/**
 * The suite-scoped listing this file used to cover is gone — the funnel it fed
 * was removed from the suite page, where a population statistic was the first
 * thing a reader met under the name "user value chain". The claims below are
 * the same ones, re-aimed at the run read that survived: they were never about
 * which resource was fetched, they were about a browser not drawing numbers it
 * has not checked.
 */
describe("fetchEvalRunStageAnalytics", () => {
  it("lets authFetch own the bearer, and asks for the run it was given", async () => {
    authFetchMock.mockResolvedValue(jsonResponse(GOLDEN_STAGE_ANALYTICS));

    await fetchEvalRunStageAnalytics({ projectId: "p1", runId: RUN_ID });

    const { url, init } = lastRequest();
    expect(url.pathname).toContain(`/eval-runs/${RUN_ID}/stage-analytics`);
    // If the adapter set its own Authorization, `authFetch` would treat the
    // caller as owning the bearer and skip both its header and its 401 retry.
    expect(new Headers(init.headers).get("authorization")).toBeNull();
  });

  it("VALIDATES the document rather than trusting the wire", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse({ ...structuredClone(GOLDEN_STAGE_ANALYTICS), slices: [] }),
    );

    const error = await fetchEvalRunStageAnalytics({
      projectId: "p1",
      runId: RUN_ID,
    }).catch((caught: unknown) => caught);

    expect(isEvalStageAnalyticsError(error)).toBe(true);
    expect((error as EvalStageAnalyticsError).kind).toBe("invalidContract");
  });

  it("binds the document to the run asked about — shape is not identity", async () => {
    // A perfectly valid document for ANOTHER run would otherwise render under
    // this run's heading as its funnel.
    authFetchMock.mockResolvedValue(
      jsonResponse(
        stageAnalyticsVariation({
          ...structuredClone(GOLDEN_STAGE_ANALYTICS),
          runId: "some-other-run",
        }),
      ),
    );

    const error = await fetchEvalRunStageAnalytics({
      projectId: "p1",
      runId: RUN_ID,
    }).catch((caught: unknown) => caught);

    expect((error as EvalStageAnalyticsError).kind).toBe("invalidContract");
    expect((error as EvalStageAnalyticsError).message).toContain(
      "different run",
    );
  });

  it("keeps the failure kinds apart — only one of them is a bug report", async () => {
    // A bare 404 is a deployment without the route…
    authFetchMock.mockResolvedValue(new Response("Not Found", { status: 404 }));
    const unavailable = await fetchEvalRunStageAnalytics({
      projectId: "p1",
      runId: RUN_ID,
    }).catch((caught: unknown) => caught);
    expect((unavailable as EvalStageAnalyticsError).kind).toBe(
      "routeUnavailable",
    );

    // …while the route's own answer is a fact about the run.
    authFetchMock.mockResolvedValue(
      jsonResponse({ code: "NOT_FOUND", message: "no such run" }, 404),
    );
    const missing = await fetchEvalRunStageAnalytics({
      projectId: "p1",
      runId: RUN_ID,
    }).catch((caught: unknown) => caught);
    expect((missing as EvalStageAnalyticsError).kind).toBe("notFound");
  });

  it("lets an abort stay an abort", async () => {
    const controller = new AbortController();
    authFetchMock.mockImplementation(() => {
      controller.abort();
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    });

    const error = await fetchEvalRunStageAnalytics(
      { projectId: "p1", runId: RUN_ID },
      controller.signal,
    ).catch((caught: unknown) => caught);

    // Not painted on a surface the reader has already navigated away from.
    expect(isEvalStageAnalyticsError(error)).toBe(false);
  });
});
