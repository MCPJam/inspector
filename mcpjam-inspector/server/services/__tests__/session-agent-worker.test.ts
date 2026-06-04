/**
 * Tests for the service-token-authed helpers in `session-agent.ts`
 * (plan v4 §C/§D/§F). Verifies header wire shape, error classification
 * (409 lease-lost, 501 refresh-unavailable, generic 4xx/5xx), and
 * payload shaping for the durable-runner endpoints.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimJob,
  heartbeatJob,
  completeJob,
  failJob,
  personaNextTurnWorker,
  refreshDescriptorTokens,
  SessionWorkerLeaseLostError,
  SessionWorkerRefreshUnavailableError,
  SessionWorkerHttpError,
} from "../session-agent";

const originalFetch = global.fetch;

const SERVICE_TOKEN = "service-token-fixture";
const HTTP_URL = "https://convex.test";

function mockJson(status: number, body: unknown): void {
  global.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function lastFetchArgs(): { url: string; init: RequestInit } {
  const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url: String(url), init: init as RequestInit };
}

beforeEach(() => {
  process.env.INSPECTOR_SERVICE_TOKEN = SERVICE_TOKEN;
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.INSPECTOR_SERVICE_TOKEN;
});

describe("session-agent worker helpers", () => {
  it("claimJob() forwards the service token header and parses a claimed job", async () => {
    mockJson(200, {
      ok: true,
      kind: "claimed",
      jobId: "job-1",
      runId: "run-1",
      projectId: "proj-1",
      chatboxId: "cb-1",
      personaId: "p-1",
      sessionIndex: 0,
      attemptCount: 1,
      leaseOwner: "w-1",
      leaseExpiresAt: 1_000_000,
      runtimeDescriptor: {
        selectedServerIds: ["srv-1"],
        perServer: [
          { serverId: "srv-1", transportType: "http", url: "https://x.test" },
        ],
      },
      persona: {
        id: "p-1",
        name: "Alice",
        role: "user",
        notes: "patient",
      },
      maxTurns: 5,
    });
    const result = await claimJob(HTTP_URL, {
      workerInstanceId: "w-1",
      workerScope: "any",
    });
    expect(result).toEqual({
      kind: "claimed",
      jobId: "job-1",
      runId: "run-1",
      projectId: "proj-1",
      chatboxId: "cb-1",
      personaId: "p-1",
      sessionIndex: 0,
      attemptCount: 1,
      leaseOwner: "w-1",
      leaseExpiresAt: 1_000_000,
      runtimeDescriptor: {
        selectedServerIds: ["srv-1"],
        perServer: [
          { serverId: "srv-1", transportType: "http", url: "https://x.test" },
        ],
      },
      persona: { id: "p-1", name: "Alice", role: "user", notes: "patient" },
      maxTurns: 5,
    });
    const { url, init } = lastFetchArgs();
    expect(url).toContain("/session-simulation/jobs/claim");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Inspector-Service-Token"]).toBe(SERVICE_TOKEN);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      workerInstanceId: "w-1",
      workerScope: "any",
    });
  });

  it("claimJob() surfaces null runtimeDescriptor for legacy v2 runs", async () => {
    mockJson(200, {
      ok: true,
      kind: "claimed",
      jobId: "job-2",
      runId: "run-2",
      projectId: "proj-1",
      chatboxId: "cb-1",
      personaId: "p-1",
      sessionIndex: 0,
      attemptCount: 1,
      leaseOwner: "w-1",
      leaseExpiresAt: 1_000_000,
      runtimeDescriptor: null,
      persona: { id: "p-1", name: "Alice", role: "user", notes: "" },
      maxTurns: 3,
    });
    const result = await claimJob(HTTP_URL, {
      workerInstanceId: "w-1",
      workerScope: "any",
    });
    expect(result.kind).toBe("claimed");
    if (result.kind !== "claimed") throw new Error("unreachable");
    expect(result.runtimeDescriptor).toBeNull();
    expect(result.maxTurns).toBe(3);
    expect(result.leaseOwner).toBe("w-1");
  });

  it("claimJob() returns kind=no_job when backend has nothing to hand out", async () => {
    mockJson(200, { ok: true, kind: "no_job" });
    const result = await claimJob(HTTP_URL, {
      workerInstanceId: "w-1",
      workerScope: "any",
    });
    expect(result).toEqual({ kind: "no_job" });
  });

  it("heartbeatJob() throws SessionWorkerLeaseLostError on 409", async () => {
    mockJson(409, { ok: false, code: "lease_lost", error: "Lease lost" });
    await expect(
      heartbeatJob(HTTP_URL, { jobId: "job-1", leaseOwner: "w-1" }),
    ).rejects.toBeInstanceOf(SessionWorkerLeaseLostError);
  });

  it("completeJob() throws SessionWorkerLeaseLostError on 409", async () => {
    mockJson(409, { ok: false, code: "lease_lost", error: "Lease lost" });
    await expect(
      completeJob(HTTP_URL, {
        jobId: "job-1",
        leaseOwner: "w-1",
        resultChatSessionId: "synth_run_p_0",
      }),
    ).rejects.toBeInstanceOf(SessionWorkerLeaseLostError);
  });

  it("failJob() POSTs errorCode + errorMessage", async () => {
    mockJson(200, { ok: true });
    await failJob(HTTP_URL, {
      jobId: "job-1",
      leaseOwner: "w-1",
      errorCode: "execution_error",
      errorMessage: "boom",
    });
    const { init } = lastFetchArgs();
    expect(JSON.parse(init.body as string)).toEqual({
      jobId: "job-1",
      leaseOwner: "w-1",
      errorCode: "execution_error",
      errorMessage: "boom",
    });
  });

  it("personaNextTurnWorker() includes jobId + runId in body", async () => {
    mockJson(200, { ok: true, message: "Hi there", endSession: false });
    const result = await personaNextTurnWorker(HTTP_URL, {
      projectId: "proj-1",
      runId: "run-1",
      jobId: "job-1",
      personaId: "p-1",
      transcriptSoFar: [{ role: "assistant", content: "Hello?" }],
    });
    expect(result).toEqual({ message: "Hi there", endSession: false });
    const { init } = lastFetchArgs();
    expect(JSON.parse(init.body as string)).toEqual({
      projectId: "proj-1",
      runId: "run-1",
      jobId: "job-1",
      personaId: "p-1",
      transcriptSoFar: [{ role: "assistant", content: "Hello?" }],
    });
  });

  it("refreshDescriptorTokens() throws SessionWorkerRefreshUnavailableError on 501", async () => {
    mockJson(501, {
      ok: false,
      code: "not_implemented",
      error: "Stage 3 TODO",
    });
    await expect(
      refreshDescriptorTokens(HTTP_URL, "run-1"),
    ).rejects.toBeInstanceOf(SessionWorkerRefreshUnavailableError);
  });

  it("generic non-2xx throws SessionWorkerHttpError with status + code", async () => {
    mockJson(500, { ok: false, code: "internal", error: "boom" });
    try {
      await failJob(HTTP_URL, {
        jobId: "job-1",
        leaseOwner: "w-1",
        errorCode: "x",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionWorkerHttpError);
      expect((err as SessionWorkerHttpError).status).toBe(500);
      expect((err as SessionWorkerHttpError).code).toBe("internal");
    }
  });

  it("throws when INSPECTOR_SERVICE_TOKEN is missing", async () => {
    delete process.env.INSPECTOR_SERVICE_TOKEN;
    await expect(
      claimJob(HTTP_URL, { workerInstanceId: "w-1", workerScope: "any" }),
    ).rejects.toThrow(/INSPECTOR_SERVICE_TOKEN/);
  });
});
