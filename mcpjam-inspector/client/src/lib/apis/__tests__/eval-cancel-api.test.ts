/**
 * The browser adapter for cancelling an eval run.
 *
 * What these pin:
 *
 *   - **Auth has ONE owner.** If the adapter lets `PlatformApiClient` set its
 *     own `Authorization`, `authFetch` treats the caller as owning the bearer
 *     and skips BOTH its header and its 401 refresh-and-retry.
 *   - **The run reaches the wire under its project**, because the route's whole
 *     advantage over the raw mutation is that it checks that pairing.
 *   - **A bare 404 is a deployment without the route; an enveloped 404 is a
 *     missing run.** The caller falls back to Convex on the first and reports
 *     the second, so collapsing them would either hide a real error or strand
 *     an older build with no way to cancel.
 *   - **A finished run is `notCancellable`, not a failure**, and keeps the
 *     route's own sentence, which names the status the run landed in.
 *   - **An abort stays an abort**, not an error painted on a surface the user
 *     just navigated away from.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { authFetchMock } = vi.hoisted(() => ({ authFetchMock: vi.fn() }));
vi.mock("@/lib/session-token", () => ({ authFetch: authFetchMock }));

import { cancelEvalRun, isCancelEvalRunError } from "../eval-cancel-api";

const PROJECT_ID = "proj-1";
const RUN_ID = "run-1";

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

const CANCELLED_RUN = {
  id: RUN_ID,
  suiteId: "suite-1",
  runNumber: 9,
  status: "cancelled",
  result: "cancelled",
  summary: null,
  source: "ui",
  notes: null,
  createdAt: 1_700_000_000_000,
  completedAt: 1_700_000_010_000,
};

beforeEach(() => {
  authFetchMock.mockReset();
});

describe("cancelEvalRun", () => {
  it("posts to the run's cancel path and leaves the bearer to authFetch", async () => {
    authFetchMock.mockResolvedValue(jsonResponse(CANCELLED_RUN));

    const run = await cancelEvalRun({
      projectId: PROJECT_ID,
      runId: RUN_ID,
    });

    expect(run.status).toBe("cancelled");
    const { url, init } = lastRequest();
    expect(url.pathname).toBe(
      `/api/v1/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/cancel`,
    );
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBeNull();
  });

  it("encodes ids rather than pasting them into the path", async () => {
    authFetchMock.mockResolvedValue(jsonResponse(CANCELLED_RUN));

    await cancelEvalRun({ projectId: "proj/one", runId: "run one" });

    expect(lastRequest().url.pathname).toBe(
      "/api/v1/projects/proj%2Fone/eval-runs/run%20one/cancel",
    );
  });

  it("reports a finished run as notCancellable, keeping the route's words", async () => {
    // The route raises 409; the v1 envelope remaps it to 400 VALIDATION_ERROR.
    authFetchMock.mockResolvedValue(
      jsonResponse(
        {
          code: "VALIDATION_ERROR",
          message: "Cannot cancel a run that already completed",
        },
        400,
      ),
    );

    await expect(
      cancelEvalRun({ projectId: PROJECT_ID, runId: RUN_ID }),
    ).rejects.toMatchObject({
      kind: "notCancellable",
      message: "Cannot cancel a run that already completed",
    });
  });

  it("separates a missing run from a deployment without the route", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse({ code: "NOT_FOUND", message: "Eval run not found" }, 404),
    );
    await expect(
      cancelEvalRun({ projectId: PROJECT_ID, runId: RUN_ID }),
    ).rejects.toMatchObject({ kind: "notFound" });

    // A bare 404 — no envelope — is a router that has never heard of the path.
    authFetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
    await expect(
      cancelEvalRun({ projectId: PROJECT_ID, runId: RUN_ID }),
    ).rejects.toMatchObject({ kind: "routeUnavailable" });
  });

  it("treats an explicit feature refusal as routeUnavailable", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse({ code: "FEATURE_NOT_SUPPORTED", message: "no" }, 400),
    );

    await expect(
      cancelEvalRun({ projectId: PROJECT_ID, runId: RUN_ID }),
    ).rejects.toMatchObject({ kind: "routeUnavailable" });
  });

  it("calls a 500 a request failure, which is neither of the above", async () => {
    authFetchMock.mockResolvedValue(
      jsonResponse({ code: "INTERNAL", message: "boom" }, 500),
    );

    await expect(
      cancelEvalRun({ projectId: PROJECT_ID, runId: RUN_ID }),
    ).rejects.toMatchObject({ kind: "requestFailed", status: 500 });
  });

  it("lets an abort stay an abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortError = new DOMException("Aborted", "AbortError");
    authFetchMock.mockRejectedValue(abortError);

    const error = await cancelEvalRun(
      { projectId: PROJECT_ID, runId: RUN_ID },
      controller.signal,
    ).catch((caught: unknown) => caught);

    expect(error).toBe(abortError);
    expect(isCancelEvalRunError(error)).toBe(false);
  });
});
