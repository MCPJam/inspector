/**
 * The browser adapter for a suite's stage analytics.
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
  fetchEvalSuiteStageAnalytics,
  isEvalStageAnalyticsError,
} from "../eval-stage-analytics-api";
import {
  GOLDEN_STAGE_ANALYTICS,
  stageAnalyticsVariation,
} from "@/test/stage-analytics-fixtures";

const SUITE_ID = GOLDEN_STAGE_ANALYTICS.suiteId;

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

describe("fetchEvalSuiteStageAnalytics", () => {
  it("reads a page and returns the validated documents", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse({ items: [GOLDEN_STAGE_ANALYTICS], nextCursor: "c2" }),
    );

    const page = await fetchEvalSuiteStageAnalytics({
      projectId: "p1",
      suiteId: SUITE_ID,
    });

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.runId).toBe(GOLDEN_STAGE_ANALYTICS.runId);
    expect(page.nextCursor).toBe("c2");
  });

  it("omits nextCursor on the last page", async () => {
    authFetchMock.mockResolvedValue(jsonResponse({ items: [] }));
    const page = await fetchEvalSuiteStageAnalytics({
      projectId: "p1",
      suiteId: SUITE_ID,
    });
    // Completeness is the ABSENCE of a cursor, not a boolean beside it.
    expect(page.nextCursor).toBeUndefined();
    expect(page.rows).toEqual([]);
  });

  it("leaves the bearer to authFetch", async () => {
    authFetchMock.mockResolvedValue(jsonResponse({ items: [] }));
    await fetchEvalSuiteStageAnalytics({ projectId: "p1", suiteId: SUITE_ID });

    const headers = new Headers(lastRequest().init.headers);
    expect(headers.has("authorization")).toBe(false);
  });

  it("puts every filter on the wire", async () => {
    authFetchMock.mockResolvedValue(jsonResponse({ items: [] }));
    await fetchEvalSuiteStageAnalytics({
      projectId: "p1",
      suiteId: SUITE_ID,
      from: 1700000000000,
      to: 1700000100000,
      runGroupId: "grp_1",
      cursor: "c1",
      limit: 10,
    });

    const { url } = lastRequest();
    expect(url.pathname).toContain("/eval-suites/");
    expect(url.pathname).toContain("/stage-analytics");
    expect(url.searchParams.get("from")).toBe("1700000000000");
    expect(url.searchParams.get("to")).toBe("1700000100000");
    expect(url.searchParams.get("runGroupId")).toBe("grp_1");
    expect(url.searchParams.get("cursor")).toBe("c1");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  it("forwards the caller's abort signal and rethrows the abort untouched", async () => {
    const controller = new AbortController();
    authFetchMock.mockImplementation(
      (_input: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const fail = () => reject(new DOMException("aborted", "AbortError"));
          if (init?.signal?.aborted) {
            fail();
            return;
          }
          init?.signal?.addEventListener("abort", fail);
        }),
    );

    const pending = fetchEvalSuiteStageAnalytics(
      { projectId: "p1", suiteId: SUITE_ID },
      controller.signal,
    ).catch((error: unknown) => error);
    controller.abort();

    const error = await pending;
    // Not dressed up as an API failure — the caller cancelled this.
    expect(isEvalStageAnalyticsError(error)).toBe(false);
    expect((error as DOMException).name).toBe("AbortError");
  });

  describe("the four failure kinds stay four", () => {
    it("maps a 404 to notFound", async () => {
      authFetchMock.mockResolvedValue(
        jsonResponse(
          { code: "NOT_FOUND", message: "Eval suite not found" },
          404,
        ),
      );
      const error = await fetchEvalSuiteStageAnalytics({
        projectId: "p1",
        suiteId: SUITE_ID,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(EvalStageAnalyticsError);
      expect((error as EvalStageAnalyticsError).kind).toBe("notFound");
    });

    it("maps a BARE 404 to routeUnavailable, not to notFound", async () => {
      // The dark-ship case, and the one a discriminator on `code` could never
      // make: `STATUS_FALLBACK_CODES` maps any bodiless 404 to `NOT_FOUND`,
      // the same code an API sends when it means the resource is missing. A
      // deployment that never shipped this function answers a bare 404 from
      // its router, and reading that as "no such thing" makes the run detail
      // claim a run was never measured instead of falling back to the legacy
      // funnel.
      //
      // The enveloped-404 test directly above is the control: same status,
      // opposite answer, and the only thing separating them is whether the
      // server sent a code of its own.
      authFetchMock.mockResolvedValue(
        new Response("<html>404 Not Found</html>", {
          status: 404,
          headers: { "content-type": "text/html" },
        }),
      );
      const error = await fetchEvalSuiteStageAnalytics({
        projectId: "p1",
        suiteId: SUITE_ID,
      }).catch((caught: unknown) => caught);

      expect((error as EvalStageAnalyticsError).kind).toBe("routeUnavailable");
    });

    it("maps a 501 to routeUnavailable", async () => {
      authFetchMock.mockResolvedValue(
        jsonResponse({ code: "NOT_IMPLEMENTED", message: "nope" }, 501),
      );
      const error = await fetchEvalSuiteStageAnalytics({
        projectId: "p1",
        suiteId: SUITE_ID,
      }).catch((caught: unknown) => caught);

      expect((error as EvalStageAnalyticsError).kind).toBe("routeUnavailable");
    });

    it("maps a 502 to requestFailed — a service state, never an empty page", async () => {
      authFetchMock.mockResolvedValue(
        jsonResponse(
          {
            code: "SERVER_UNREACHABLE",
            message: "Stage analytics payload failed validation",
          },
          502,
        ),
      );
      const error = await fetchEvalSuiteStageAnalytics({
        projectId: "p1",
        suiteId: SUITE_ID,
      }).catch((caught: unknown) => caught);

      expect((error as EvalStageAnalyticsError).kind).toBe("requestFailed");
    });

    it("maps a malformed document to invalidContract", async () => {
      const broken = structuredClone(GOLDEN_STAGE_ANALYTICS) as any;
      broken.slices[0].stages[0].passed = 99;
      authFetchMock.mockResolvedValue(jsonResponse({ items: [broken] }));

      const error = await fetchEvalSuiteStageAnalytics({
        projectId: "p1",
        suiteId: SUITE_ID,
      }).catch((caught: unknown) => caught);

      expect((error as EvalStageAnalyticsError).kind).toBe("invalidContract");
    });

    it("maps a non-envelope response to invalidContract", async () => {
      authFetchMock.mockResolvedValue(jsonResponse({ rows: [] }));
      const error = await fetchEvalSuiteStageAnalytics({
        projectId: "p1",
        suiteId: SUITE_ID,
      }).catch((caught: unknown) => caught);

      expect((error as EvalStageAnalyticsError).kind).toBe("invalidContract");
    });
  });

  it("refuses a document for a different suite", async () => {
    // Shape is not identity: a perfectly valid document for ANOTHER suite would
    // otherwise render under this suite's heading as its funnel.
    authFetchMock.mockResolvedValue(
      jsonResponse({
        items: [stageAnalyticsVariation({ suiteId: "some-other-suite" })],
      }),
    );

    const error = await fetchEvalSuiteStageAnalytics({
      projectId: "p1",
      suiteId: SUITE_ID,
    }).catch((caught: unknown) => caught);

    expect((error as EvalStageAnalyticsError).kind).toBe("invalidContract");
    expect((error as EvalStageAnalyticsError).message).toContain(
      "different suite",
    );
  });
});
