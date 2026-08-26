/**
 * The browser adapter for D9's canonical run decision summary.
 *
 * What these pin, and why each one is a bug that has actually shipped in this
 * codebase's neighbourhood before:
 *
 *   - **Auth has ONE owner.** If the adapter lets `PlatformApiClient` set its
 *     own `Authorization`, `authFetch` treats the caller as owning the bearer
 *     and skips BOTH its header and its 401 refresh-and-retry. The failure is
 *     invisible until a token expires mid-session.
 *   - **Cursor and limit reach the wire.** A dropped cursor silently re-reads
 *     page one forever; a dropped limit reads a different page size than the
 *     cache key claims.
 *   - **An abort stays an abort.** Dressing a caller's cancellation up as an
 *     API failure paints an error on a surface the user just navigated away
 *     from.
 *   - **The four failure kinds stay four.** `notFound`, `routeUnavailable` and
 *     `invalidContract` are three different facts, and only the last is a bug
 *     report.
 *   - **The payload is VALIDATED, not trusted.** An unvalidated summary would
 *     put a verdict on screen that nothing checked against the decision shipped
 *     beside it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { authFetchMock } = vi.hoisted(() => ({ authFetchMock: vi.fn() }));
vi.mock("@/lib/session-token", () => ({ authFetch: authFetchMock }));

import {
  EvalRunDecisionSummaryError,
  fetchEvalRunDecisionSummary,
  isEvalRunDecisionSummaryError,
} from "../eval-run-decision-summary-api";
import { readDecisionSummaryFixture } from "@/test/eval-decision-summary-fixtures";

const PASSING = readDecisionSummaryFixture("policyV2-passing");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function lastCall(): [RequestInfo | URL, RequestInit | undefined] {
  const call = authFetchMock.mock.calls.at(-1);
  if (!call) throw new Error("authFetch was never called");
  return call as [RequestInfo | URL, RequestInit | undefined];
}

describe("fetchEvalRunDecisionSummary", () => {
  beforeEach(() => {
    authFetchMock.mockReset();
  });

  it("leaves the bearer to authFetch and never sets its own", async () => {
    authFetchMock.mockResolvedValue(jsonResponse(PASSING));

    await fetchEvalRunDecisionSummary({ projectId: "p1", runId: "run-1" });

    const [, init] = lastCall();
    const headers = new Headers(init?.headers);
    expect(headers.has("authorization")).toBe(false);
  });

  it("sends the project, run, cursor and limit it was given", async () => {
    authFetchMock.mockResolvedValue(jsonResponse(PASSING));

    await fetchEvalRunDecisionSummary({
      projectId: "proj space",
      runId: "run/1",
      cursor: "cur-2",
      limit: 25,
    });

    const [input] = lastCall();
    const url = new URL(String(input), "http://localhost");
    expect(url.pathname).toBe(
      "/api/v1/projects/proj%20space/eval-runs/run%2F1/decision-summary",
    );
    expect(url.searchParams.get("cursor")).toBe("cur-2");
    expect(url.searchParams.get("limit")).toBe("25");
  });

  it("omits the cursor entirely for a first page", async () => {
    authFetchMock.mockResolvedValue(jsonResponse(PASSING));

    await fetchEvalRunDecisionSummary({
      projectId: "p1",
      runId: "run-1",
      limit: 1,
    });

    const [input] = lastCall();
    const url = new URL(String(input), "http://localhost");
    expect(url.searchParams.has("cursor")).toBe(false);
    expect(url.searchParams.get("limit")).toBe("1");
  });

  it("returns the validated contract object", async () => {
    authFetchMock.mockResolvedValue(jsonResponse(PASSING));

    const summary = await fetchEvalRunDecisionSummary({
      projectId: "p1",
      runId: "run-1",
    });

    expect(summary).toEqual(PASSING);
  });

  it("rethrows a caller's abort untouched rather than as an API failure", async () => {
    authFetchMock.mockImplementation((_input, init) => {
      if ((init as RequestInit | undefined)?.signal?.aborted) {
        return Promise.reject(new DOMException("Aborted", "AbortError"));
      }
      return Promise.resolve(jsonResponse(PASSING));
    });
    const controller = new AbortController();
    controller.abort();

    const error = await fetchEvalRunDecisionSummary(
      { projectId: "p1", runId: "run-1" },
      controller.signal,
    ).catch((caught: unknown) => caught);

    expect(isEvalRunDecisionSummaryError(error)).toBe(false);
  });

  it("reports a 404 as notFound, which is a fact about the run", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse({ code: "NOT_FOUND", message: "Eval run not found" }, 404),
    );

    const error = await fetchEvalRunDecisionSummary({
      projectId: "p1",
      runId: "missing",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EvalRunDecisionSummaryError);
    expect((error as EvalRunDecisionSummaryError).kind).toBe("notFound");
  });

  it.each([
    ["FEATURE_NOT_SUPPORTED at 404", "FEATURE_NOT_SUPPORTED", 404],
    ["a 501", "NOT_IMPLEMENTED", 501],
    ["a 405", "METHOD_NOT_ALLOWED", 405],
  ])(
    "reports %s as routeUnavailable, not as a missing run",
    async (_name, code, status) => {
      authFetchMock.mockResolvedValue(
        jsonResponse({ code, message: "nope" }, status),
      );

      const error = await fetchEvalRunDecisionSummary({
        projectId: "p1",
        runId: "run-1",
      }).catch((caught: unknown) => caught);

      expect((error as EvalRunDecisionSummaryError).kind).toBe(
        "routeUnavailable",
      );
    },
  );

  it("reports a 5xx as requestFailed", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse({ code: "INTERNAL_ERROR", message: "boom" }, 500),
    );

    const error = await fetchEvalRunDecisionSummary({
      projectId: "p1",
      runId: "run-1",
    }).catch((caught: unknown) => caught);

    expect((error as EvalRunDecisionSummaryError).kind).toBe("requestFailed");
  });

  it("refuses a payload that does not validate against the contract", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse({
        ...PASSING,
        // A policy-v2 summary whose counts are not the tally of its own
        // decision. The contract refuses it precisely so a renderer's
        // "2/3 passed" cannot drift from the decision it claims to read.
        counts: {
          measurementUnit: "caseVariant",
          total: 99,
          passed: 99,
          failed: 0,
          inconclusive: 0,
        },
      }),
    );

    const error = await fetchEvalRunDecisionSummary({
      projectId: "p1",
      runId: "run-1",
    }).catch((caught: unknown) => caught);

    expect((error as EvalRunDecisionSummaryError).kind).toBe("invalidContract");
  });

  it("refuses an unknown field rather than letting it ride along", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse({ ...PASSING, somethingNew: true }),
    );

    const error = await fetchEvalRunDecisionSummary({
      projectId: "p1",
      runId: "run-1",
    }).catch((caught: unknown) => caught);

    expect((error as EvalRunDecisionSummaryError).kind).toBe("invalidContract");
  });
});
