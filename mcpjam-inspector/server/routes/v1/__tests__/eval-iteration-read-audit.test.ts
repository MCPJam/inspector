import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * G2d — the two per-iteration read routes report the read to the platform.
 *
 * What these tests pin is mostly about the SHAPE of the report rather than
 * that one is sent, because the ways this can be subtly wrong are all silent:
 *
 *  * The caller's Convex bearer must be forwarded ALONGSIDE the service token,
 *    not instead of it, and must be the bearer the read itself used. The
 *    platform resolves the acting human from it, so a report that carried only
 *    the service token would file every read under nobody.
 *  * A failure must never reach the caller. The report runs after the response
 *    body already resolved; turning a served trace into a 500 because an audit
 *    row could not be written is strictly worse than not writing it.
 *  * A 404 must report nothing. A row is a claim that a transcript left the
 *    product, and no transcript left on a `TRACE_NOT_AVAILABLE`.
 */

const {
  validateGuestTokenMock,
  convexQueryMock,
  convexActionMock,
  fetchMock,
  reportRouteFailureMock,
} = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  convexQueryMock: vi.fn(),
  convexActionMock: vi.fn(),
  fetchMock: vi.fn(),
  reportRouteFailureMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: convexQueryMock,
    mutation: vi.fn(),
    action: convexActionMock,
  })),
}));

vi.mock("../../../utils/route-error-report.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/route-error-report.js")
  >("../../../utils/route-error-report.js");
  return { ...actual, reportRouteFailure: reportRouteFailureMock };
});

import v1Routes from "../index.js";

const PROJECT_ID = "p1";
const RUN_ID = "run1xxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const ITERATION_ID = "iter1xxxxxxxxxxxxxxxxxxxxxxxxxxx";
const BEARER = "caller-bearer-token";
const SERVICE_TOKEN = "inspector-service-token";
const CONVEX_HTTP_URL = "https://example.convex.site";
const AUDIT_URL = `${CONVEX_HTTP_URL}/internal/v1/evals/iteration-read`;

const RUN_DOC = {
  _id: RUN_ID,
  projectId: PROJECT_ID,
  suiteId: "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
  runNumber: 1,
  status: "completed",
  result: "passed",
  createdAt: 1,
};

const ITERATION_DOC = {
  _id: ITERATION_ID,
  suiteRunId: RUN_ID,
  testCaseSnapshot: {
    title: "a case",
    query: "do the thing",
    steps: [{ id: "s1", kind: "prompt", prompt: "do the thing" }],
  },
  metadata: { stepResults: [{ id: "s1", status: "passed" }] },
  status: "completed",
  result: "passed",
};

const TRACE = { messages: [{ role: "user", content: "do the thing" }] };

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

function read(kind: "trace" | "steps"): Promise<Response> {
  return makeApp().request(
    `/api/v1/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/iterations/${ITERATION_ID}/${kind}`,
    { method: "GET", headers: { Authorization: `Bearer ${BEARER}` } }
  );
}

/** The single audit POST, failing loudly when there is not exactly one. */
function auditCall(): { url: string; init: RequestInit } {
  const calls = fetchMock.mock.calls.filter(
    (call) => String(call[0]) === AUDIT_URL
  );
  expect(calls).toHaveLength(1);
  return { url: String(calls[0][0]), init: calls[0][1] as RequestInit };
}

function auditBody(): Record<string, unknown> {
  return JSON.parse(String(auditCall().init.body));
}

function auditHeaders(): Record<string, string> {
  return auditCall().init.headers as Record<string, string>;
}

beforeEach(() => {
  vi.stubEnv("CONVEX_URL", "https://example.convex.cloud");
  vi.stubEnv("CONVEX_HTTP_URL", CONVEX_HTTP_URL);
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", SERVICE_TOKEN);
  validateGuestTokenMock.mockResolvedValue({ valid: false });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ ok: true, recorded: true }), { status: 200 })
  );
  convexQueryMock.mockImplementation((name: string) => {
    if (name === "testSuites:getTestSuiteRun") return Promise.resolve(RUN_DOC);
    if (name === "testSuites:getTestIteration")
      return Promise.resolve(ITERATION_DOC);
    return Promise.resolve(null);
  });
  convexActionMock.mockResolvedValue(TRACE);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("GET …/iterations/:iterationId/trace — read audit", () => {
  it("forwards the caller's bearer ALONGSIDE the service token", async () => {
    const res = await read("trace");
    expect(res.status).toBe(200);

    const headers = auditHeaders();
    // The service token AUTHORIZES the report…
    expect(headers["x-inspector-service-token"]).toBe(SERVICE_TOKEN);
    // …and the caller's bearer NAMES THE HUMAN. Sending only the first would
    // leave the platform with no actor to resolve; sending the service token
    // in this slot would be worse still.
    expect(headers.authorization).toBe(`Bearer ${BEARER}`);
    expect(headers.authorization).not.toContain(SERVICE_TOKEN);
  });

  it("names the iteration and the size that was served, not the trace", async () => {
    await read("trace");

    const body = auditBody();
    expect(body.iterationId).toBe(ITERATION_ID);
    expect(body.mode).toBe("trace");
    expect(body.traceBytes).toBe(
      Buffer.byteLength(JSON.stringify(TRACE), "utf8")
    );
    // How much left the product, never what was in it.
    expect(JSON.stringify(body)).not.toContain("do the thing");
  });

  it("still serves the trace when the audit report fails", async () => {
    fetchMock.mockRejectedValue(new Error("platform unreachable"));

    const res = await read("trace");

    // The read already resolved before the report was attempted. Failing it
    // here would trade a served response for a missing audit row.
    expect(res.status).toBe(200);
    // The whole trace, unchanged — `v1Resource` serves the resource itself,
    // so this is the caller's actual response body, not an envelope field.
    expect(await res.json()).toEqual(TRACE);
    // `waitFor`, not a bare assertion: the audit is DETACHED, so the response
    // is allowed to land before the failure is reported. Asserting
    // synchronously here would be asserting on that race.
    await vi.waitFor(() =>
      expect(reportRouteFailureMock).toHaveBeenCalledTimes(1)
    );
  });

  it("still serves the trace when the platform route is not deployed yet", async () => {
    // Convex's own routing 404 — what this looks like before the backend half
    // ships. Deliberately a soft landing, not a claim the ordering is optional.
    fetchMock.mockResolvedValue(new Response("Not Found", { status: 404 }));

    const res = await read("trace");

    expect(res.status).toBe(200);
    await vi.waitFor(() =>
      expect(reportRouteFailureMock).toHaveBeenCalledTimes(1)
    );
  });

  it("serves the trace without waiting for the audit to answer", async () => {
    // A backend that accepts the POST and never replies. Awaiting the audit
    // would hold this response open behind it; detaching means the caller is
    // unaffected by our bookkeeping being stuck.
    fetchMock.mockReturnValue(new Promise(() => {}));

    const res = await read("trace");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(TRACE);
    // …and the request really was in flight, so this is not passing by never
    // having attempted it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds the audit request so a stalled backend cannot hold it forever", async () => {
    await read("trace");

    // `fetch` has no default timeout, so without a signal a half-open
    // connection would retain the request and its socket indefinitely.
    const signal = (auditCall().init as { signal?: AbortSignal }).signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
  });

  it("releases the deadline timer once the audit settles", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    await read("trace");

    // Without the `finally`, every read would leave a 5s timer pending —
    // harmless once, a per-request leak that keeps the event loop busy at
    // volume, and the reason the deadline is cleared rather than just set.
    await vi.waitFor(() => expect(clearTimeoutSpy).toHaveBeenCalled());
    clearTimeoutSpy.mockRestore();
  });

  it("reports nothing when there is no trace to read", async () => {
    convexActionMock.mockResolvedValue(null);

    const res = await read("trace");

    expect(res.status).toBe(404);
    // A row asserts that a transcript left the product. Nothing left here.
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]) === AUDIT_URL)
    ).toHaveLength(0);
  });

  it("reports nothing when the iteration does not belong to the run", async () => {
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:getTestSuiteRun")
        return Promise.resolve(RUN_DOC);
      if (name === "testSuites:getTestIteration")
        return Promise.resolve({ ...ITERATION_DOC, suiteRunId: "other_run" });
      return Promise.resolve(null);
    });

    const res = await read("trace");

    expect(res.status).toBe(404);
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]) === AUDIT_URL)
    ).toHaveLength(0);
  });
});

describe("GET …/iterations/:iterationId/steps — read audit", () => {
  it("files under its own mode and counts the steps it returned", async () => {
    const res = await read("steps");
    expect(res.status).toBe(200);

    const body = auditBody();
    expect(body.mode).toBe("steps");
    expect(body.stepCount).toBe(1);
    expect(body.iterationId).toBe(ITERATION_ID);
    expect(auditHeaders().authorization).toBe(`Bearer ${BEARER}`);
  });

  it("omits the trace size when no evidence resolved", async () => {
    // Unlike `/trace`, a missing envelope is NOT a 404 here — verdicts still
    // return — so the field's absence is how the row says "verdicts only",
    // rather than claiming a zero-byte trace was served.
    convexActionMock.mockResolvedValue(null);

    const res = await read("steps");
    expect(res.status).toBe(200);

    const body = auditBody();
    expect(body).not.toHaveProperty("traceBytes");
    expect(body.stepCount).toBe(1);
  });

  it("still serves the verdicts when the audit report fails", async () => {
    fetchMock.mockRejectedValue(new Error("platform unreachable"));

    const res = await read("steps");

    expect(res.status).toBe(200);
    await vi.waitFor(() =>
      expect(reportRouteFailureMock).toHaveBeenCalledTimes(1)
    );
  });

  it("serves the verdicts without waiting for the audit to answer", async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));

    const res = await read("steps");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
