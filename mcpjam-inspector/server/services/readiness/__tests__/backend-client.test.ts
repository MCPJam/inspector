/**
 * The lease protocol's sharp edges, exercised directly.
 *
 * Four behaviours here are decisions rather than plumbing, and each fails in a
 * direction the caller cannot see:
 *
 *   1. THE HEARTBEAT FAILS OPEN. A network blip between two healthy machines
 *      must not abort a run that is going fine — the backend's recovery cron
 *      is what reclaims a genuinely dead node, and it measures the heartbeat
 *      rather than trusting this call's opinion.
 *   2. A `409` IS A LOST LEASE, and the only thing here that throws. It means
 *      this node has no business writing anything for this run.
 *   3. AN OVERSIZED REPORT BECOMES A FAILED RUN, not a lost one: recording the
 *      reason is what tells a reader why they have no report.
 *   4. AN UNKNOWN BROKER STATUS IS REFUSED, because the value lands on the run
 *      row and a surface branches on it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ReadinessLeaseLostError,
  ReadinessSubmissionUnreadableError,
  claimReadinessRun,
  confirmReadinessLease,
  failReadinessRun,
  finalizeReadinessRun,
  getReadinessRunSubmission,
  heartbeatReadinessRun,
  requestManagedObservations,
} from "../backend-client.js";

const LEASE = { runId: "run_1", jobId: "job_1" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = "https://backend.test";
  process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CONVEX_HTTP_URL;
  delete process.env.INSPECTOR_SERVICE_TOKEN;
});

describe("heartbeatReadinessRun", () => {
  it("reports the lease as gone when the backend says so", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: true, alive: false })),
    );
    expect(await heartbeatReadinessRun(LEASE)).toEqual({ alive: false });
  });

  it.each([
    ["a transport failure", () => Promise.reject(new Error("ECONNRESET"))],
    ["a 500", async () => new Response("boom", { status: 500 })],
    [
      "an unreadable body",
      async () => new Response("not json", { status: 200 }),
    ],
  ])("fails OPEN on %s", async (_label, responder) => {
    // Failing closed here would mean a flaky link killing good runs, which is
    // worse than a dead node living for one extra lease period.
    vi.stubGlobal("fetch", vi.fn(responder as never));
    expect(await heartbeatReadinessRun(LEASE)).toEqual({ alive: true });
  });

  it("sends the lease and the service token", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, alive: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await heartbeatReadinessRun(LEASE);

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, any];
    expect(String(url)).toContain(
      "/internal/v1/claude-readiness/runs/heartbeat",
    );
    expect(init.headers["x-inspector-service-token"]).toBe("service-token");
    expect(JSON.parse(init.body)).toEqual(LEASE);
  });
});

describe("confirmReadinessLease", () => {
  it.each([
    ["owned", { ok: true, alive: true }],
    ["lost", { ok: true, alive: false }],
  ])("reports %s when the backend answers", async (answer, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(body)),
    );
    expect(await confirmReadinessLease(LEASE)).toBe(answer);
  });

  it.each([
    ["a transport failure", () => Promise.reject(new Error("ECONNRESET"))],
    ["a 500", async () => new Response("boom", { status: 500 })],
    [
      "an unreadable body",
      async () => new Response("not json", { status: 200 }),
    ],
  ])("never reads %s as ownership", async (_label, responder) => {
    // A caller about to start work on the lease must not start it on a guess.
    vi.stubGlobal("fetch", vi.fn(responder as never));
    expect(await confirmReadinessLease(LEASE)).toBe("unanswered");
  });
});

describe("claimReadinessRun", () => {
  it("claims with the lease and the service token", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, claimed: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await claimReadinessRun(LEASE)).toEqual({ status: "claimed" });

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, any];
    expect(String(url)).toBe(
      "https://backend.test/internal/v1/claude-readiness/runs/claim",
    );
    expect(init.headers["x-inspector-service-token"]).toBe("service-token");
    expect(JSON.parse(init.body)).toEqual(LEASE);
  });

  it.each([
    [409, "already_claimed"],
    [409, "lease_lost"],
    [404, "not_found"],
  ] as const)("reports a %s %s as a refusal", async (status, error) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: false, error }, status)),
    );
    expect(await claimReadinessRun(LEASE)).toEqual({
      status: "refused",
      reason: error,
    });
  });

  it.each([
    ["a transport failure", () => Promise.reject(new Error("ECONNRESET"))],
    ["a 500", async () => new Response("boom", { status: 500 })],
    // A backend without the route answers its router's own 404.
    [
      "a 404 with no refusal",
      async () => new Response("No matching routes found", { status: 404 }),
    ],
    [
      "a refusal it does not know",
      async () => jsonResponse({ ok: false, error: "unauthorized" }, 401),
    ],
  ])("reports %s as unanswered, which is not a refusal", async (_label, responder) => {
    vi.stubGlobal("fetch", vi.fn(responder as never));
    expect((await claimReadinessRun(LEASE)).status).toBe("unanswered");
  });
});

describe("requestManagedObservations", () => {
  it("passes a completed answer through with its envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          status: "completed",
          envelope: { readinessKind: "claude-directory-readiness" },
        }),
      ),
    );
    const answer = await requestManagedObservations(LEASE, "tools: none");
    expect(answer.status).toBe("completed");
    expect(answer.envelope).toEqual({
      readinessKind: "claude-directory-readiness",
    });
  });

  it("throws a lost lease on 409, which is the node's signal to stop", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: false, error: "lease_lost" }, 409)),
    );
    await expect(
      requestManagedObservations(LEASE, "evidence"),
    ).rejects.toBeInstanceOf(ReadinessLeaseLostError);
  });

  it.each([
    ["an unreachable broker", () => Promise.reject(new Error("ECONNRESET"))],
    [
      "a refusal",
      async () =>
        jsonResponse({ ok: false, error: "observations_not_requested" }, 403),
    ],
    [
      "an unreadable body",
      async () => new Response("not json", { status: 200 }),
    ],
    ["a body with no status", async () => jsonResponse({ ok: true })],
    [
      "a status this build does not know",
      async () => jsonResponse({ ok: true, status: "vibes-based" }),
    ],
  ])(
    "degrades %s to a provider failure rather than throwing",
    async (_label, responder) => {
      // Every one of these must leave the deterministic run intact: a thrown
      // error here would fail a readiness grade over a feature the caller could
      // have skipped entirely.
      vi.stubGlobal("fetch", vi.fn(responder as never));
      const answer = await requestManagedObservations(LEASE, "evidence");
      expect(answer.status).toBe("provider-failed");
      expect(answer.reason).toBe("provider_error");
      expect(answer.envelope).toBeUndefined();
    },
  );

  it("preserves a stored policy refusal returned with HTTP 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          status: "ai-unavailable",
          reason: "ai_unavailable",
          refusalCode: "org_runtime_unsupported",
          detail: "Unavailable on organization keys.",
        }),
      ),
    );
    expect(await requestManagedObservations(LEASE, "evidence")).toMatchObject({
      status: "ai-unavailable",
      reason: "ai_unavailable",
      refusalCode: "org_runtime_unsupported",
    });
  });

  it("reads the organization's AI-key policy refusal as ai_unavailable, not a provider failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            ok: false,
            code: "org_model_unconfigured",
            error: "No organization model is set for this role.",
            isRetryable: false,
            remediation: "configure_org_model_role",
          },
          422,
        ),
      ),
    );
    const answer = await requestManagedObservations(LEASE, "evidence");
    expect(answer.status).toBe("ai-unavailable");
    expect(answer.reason).toBe("ai_unavailable");
    expect(answer.refusalCode).toBe("org_model_unconfigured");
    expect(answer.detail).toContain("org_model_unconfigured");
    expect(answer.envelope).toBeUndefined();
  });

  it("names the observation pass and carries the evidence", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, status: "completed", envelope: {} }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await requestManagedObservations(LEASE, "tools: search_docs");

    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, any];
    expect(JSON.parse(init.body)).toEqual({
      ...LEASE,
      observationKind: "experience",
      evidence: "tools: search_docs",
    });
  });
});

describe("finalizeReadinessRun", () => {
  const SUMMARY = {
    overallStatus: "ready" as const,
    lanes: [],
    authMode: "headless" as const,
    capabilities: [],
    policySnapshotDate: "2026-08-19",
    engineVersion: "1",
  };

  it("reports whether the write was applied", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: true, applied: true })),
    );
    expect(await finalizeReadinessRun(LEASE, SUMMARY, {})).toEqual({
      applied: true,
    });
  });

  it("turns an oversized report into a FAILED run with a reason", async () => {
    // Not a lost run. Silence would read as a node that vanished; the reason
    // is what tells a reader why they have no report.
    const calls: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: any, init: any) => {
        const body = JSON.parse(String(init.body));
        calls.push(body);
        if (body.outcome === "failed") {
          return jsonResponse({ ok: true, applied: true });
        }
        return jsonResponse({ ok: false, error: "Payload exceeds" }, 413);
      }),
    );

    expect(await finalizeReadinessRun(LEASE, SUMMARY, {})).toEqual({
      applied: false,
    });
    expect(calls[1]).toMatchObject({
      outcome: "failed",
      terminalReason: "report_too_large",
    });
  });

  it("reports not-applied when the run is gone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: false, error: "not_found" }, 404)),
    );
    expect(await finalizeReadinessRun(LEASE, SUMMARY, {})).toEqual({
      applied: false,
    });
  });

  it("throws on an unexpected backend error, so the worker can record it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: false, error: "boom" }, 500)),
    );
    await expect(finalizeReadinessRun(LEASE, SUMMARY, {})).rejects.toThrow(
      /500/,
    );
  });
});

describe("failReadinessRun", () => {
  it("carries the terminal reason and the message", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, applied: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await failReadinessRun(LEASE, "runner_error", "it broke")).toEqual({
      applied: true,
    });
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, any];
    expect(JSON.parse(init.body)).toMatchObject({
      outcome: "failed",
      terminalReason: "runner_error",
      errorMessage: "it broke",
    });
  });

  it("reports not-applied rather than throwing when the write is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    expect(await failReadinessRun(LEASE, "runner_error")).toEqual({
      applied: false,
    });
  });
});

describe("getReadinessRunSubmission", () => {
  const FROZEN = {
    submissionId: "sub_1",
    submissionRevision: 3,
    flowId: "claude-connector",
    flowVersion: "2026-11-13",
    answers: [{ key: "listing.name", value: "Acme", origin: "set", revision: 3 }],
  };

  it("reads the frozen answers behind the lease, and keeps only their fields", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, ...FROZEN }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await getReadinessRunSubmission(LEASE)).toEqual(FROZEN);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, any];
    expect(String(url)).toBe(
      "https://backend.test/internal/v1/claude-readiness/runs/submission?runId=run_1&jobId=job_1",
    );
    expect(init.headers["x-inspector-service-token"]).toBe("service-token");
  });

  it("throws a lost lease on 409, so the worker stops without writing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: false, error: "lease_lost" }, 409)),
    );
    await expect(getReadinessRunSubmission(LEASE)).rejects.toBeInstanceOf(
      ReadinessLeaseLostError,
    );
  });

  it.each([
    ["a 404", () => jsonResponse({ ok: false, error: "no_submission" }, 404), /were not found/],
    ["a 500", () => jsonResponse({ ok: false, error: "boom" }, 500), /HTTP 500/],
    ["a body that is not JSON", () => new Response("oops", { status: 200 }), /could not be read/],
    [
      "an answer with no key",
      () => jsonResponse({ ok: true, ...FROZEN, answers: [{ value: "x", origin: "set" }] }),
      /could not be read/,
    ],
    ["an unreachable backend", () => Promise.reject(new Error("ECONNRESET")), /could not be read/],
  ])("refuses %s with a reason the run can carry", async (_label, responder, reason) => {
    vi.stubGlobal("fetch", vi.fn(responder as never));
    const failure = getReadinessRunSubmission(LEASE);
    await expect(failure).rejects.toBeInstanceOf(ReadinessSubmissionUnreadableError);
    await expect(failure).rejects.toThrow(reason);
  });
});
