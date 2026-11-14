/**
 * A run that carries a reviewer attempt rehearses the sign-in before grading.
 * A rehearsal that stops for a person ends the run there, freeing its slot;
 * one that connects ends the attempt passed before the finalize releases the
 * lease; one that fails still grades the submission without the account.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const claimReadinessRun = vi.fn();
const heartbeatReadinessRun = vi.fn();
const finalizeReadinessRun = vi.fn();
const failReadinessRun = vi.fn();
const joinReviewerAttempt = vi.fn();
const recordReviewerAttempt = vi.fn();

// The real classes: the worker tells them apart with `instanceof`.
const { ReadinessLeaseLostError } = await import("../runner.js");
const { ReadinessSubmissionUnreadableError } = await vi.importActual<
  typeof import("../backend-client.js")
>("../backend-client.js");

vi.mock("../backend-client.js", () => ({
  claimReadinessRun: (...args: unknown[]) => claimReadinessRun(...args),
  heartbeatReadinessRun: (...args: unknown[]) => heartbeatReadinessRun(...args),
  finalizeReadinessRun: (...args: unknown[]) => finalizeReadinessRun(...args),
  failReadinessRun: (...args: unknown[]) => failReadinessRun(...args),
  joinReviewerAttempt: (...args: unknown[]) => joinReviewerAttempt(...args),
  recordReviewerAttempt: (...args: unknown[]) => recordReviewerAttempt(...args),
  requestManagedObservations: vi.fn(),
  getReadinessRunSubmission: vi.fn(),
  ReadinessLeaseLostError,
  ReadinessSubmissionUnreadableError,
}));

// Dynamic, after the mock: see the same note in `worker.test.ts`.
const { executeHostedReadinessRun } = await import("../worker.js");

const LEASE = { runId: "run_1", jobId: "job_1" };
const ATTEMPT = {
  projectId: "proj_1",
  passwordSecretName: "MCPJAM_REVIEWER_ACME_PASSWORD",
  username: "review@example.com",
};

/** A server that initializes and lists one tool, enough to grade. */
function serverFetch() {
  return vi.fn(
    async (_url: unknown, init?: { method?: string; body?: unknown }) => {
      const method = String(init?.method ?? "GET").toUpperCase();
      if (method !== "POST") return new Response("", { status: 404 });
      const body = JSON.parse(String(init?.body ?? "{}"));
      const results: Record<string, unknown> = {
        initialize: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          serverInfo: { name: "demo", version: "1" },
        },
        "tools/list": { tools: [] },
        "resources/list": { resources: [] },
      };
      const result = results[String(body.method)];
      return new Response(
        JSON.stringify(
          result === undefined
            ? {
                jsonrpc: "2.0",
                id: body.id,
                error: { code: -32601, message: "unknown" },
              }
            : { jsonrpc: "2.0", id: body.id, result },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );
}

function run(
  reviewerSignIn: ReturnType<typeof vi.fn>,
  fetchFn = serverFetch(),
) {
  return {
    fetchFn,
    done: executeHostedReadinessRun({
      lease: LEASE,
      publisher: "claude",
      target: "https://connector.example.com/mcp",
      fetchFn: fetchFn as unknown as typeof fetch,
      includeLlmObservations: false,
      reviewerAttemptId: "att_1",
      reviewerSignIn: reviewerSignIn as never,
    }),
  };
}

beforeEach(() => {
  claimReadinessRun.mockResolvedValue({ status: "claimed" });
  heartbeatReadinessRun.mockResolvedValue({ alive: true });
  finalizeReadinessRun.mockResolvedValue({ applied: true });
  failReadinessRun.mockResolvedValue({ applied: true });
  joinReviewerAttempt.mockResolvedValue({ joined: true, attempt: ATTEMPT });
  recordReviewerAttempt.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("a run that rehearses the reviewer's sign-in", () => {
  it("rehearses on the attempt it joined, with the run's lease and abort signal", async () => {
    const signIn = vi.fn(async () => ({ kind: "failed", detail: "refused" }));
    await run(signIn).done;
    expect(signIn).toHaveBeenCalledWith({
      lease: LEASE,
      attemptId: "att_1",
      attempt: ATTEMPT,
      signal: expect.any(AbortSignal),
    });
    expect(joinReviewerAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      signIn.mock.invocationCallOrder[0]!,
    );
  });

  it("ends the run as waiting for a person, without grading", async () => {
    const signIn = vi.fn(async () => ({
      kind: "waiting-for-person",
      reason: "The sign-in page asked for a verification code.",
      action: "Complete the verification, then resume this attempt.",
    }));
    const { fetchFn, done } = run(signIn);
    await done;
    expect(failReadinessRun).toHaveBeenCalledWith(
      LEASE,
      "waiting_for_person",
      expect.stringContaining("resume the reviewer attempt"),
    );
    expect(fetchFn).not.toHaveBeenCalled();
    expect(finalizeReadinessRun).not.toHaveBeenCalled();
    expect(recordReviewerAttempt).not.toHaveBeenCalled();
  });

  it("grades with a connected account, then ends the attempt passed before finalizing", async () => {
    const signIn = vi.fn(async () => ({
      kind: "connected",
      reviewerAccountId: "acct_1",
    }));
    const { fetchFn, done } = run(signIn);
    await done;
    expect(fetchFn).toHaveBeenCalled();
    expect(recordReviewerAttempt).toHaveBeenCalledWith(LEASE, "att_1", {
      outcome: "passed",
      detail: expect.stringContaining("graded the submission"),
    });
    expect(recordReviewerAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      finalizeReadinessRun.mock.invocationCallOrder[0]!,
    );
    expect(failReadinessRun).not.toHaveBeenCalled();
  });

  it("still grades after a failed rehearsal, and leaves the attempt as the rehearsal ended it", async () => {
    const signIn = vi.fn(async () => ({ kind: "failed", detail: "refused" }));
    const { fetchFn, done } = run(signIn);
    await done;
    expect(fetchFn).toHaveBeenCalled();
    expect(finalizeReadinessRun).toHaveBeenCalledTimes(1);
    expect(recordReviewerAttempt).not.toHaveBeenCalled();
  });

  it("keeps the grade when the attempt can no longer be ended", async () => {
    recordReviewerAttempt.mockRejectedValue(new Error("attempt_not_running"));
    const signIn = vi.fn(async () => ({
      kind: "connected",
      reviewerAccountId: "acct_1",
    }));
    await run(signIn).done;
    expect(finalizeReadinessRun).toHaveBeenCalledTimes(1);
  });

  it("writes nothing more when the lease is lost while ending the attempt", async () => {
    recordReviewerAttempt.mockRejectedValue(new ReadinessLeaseLostError());
    const signIn = vi.fn(async () => ({
      kind: "connected",
      reviewerAccountId: "acct_1",
    }));
    await run(signIn).done;
    expect(finalizeReadinessRun).not.toHaveBeenCalled();
    expect(failReadinessRun).not.toHaveBeenCalled();
  });

  it("rehearses nothing when the join did not return the attempt", async () => {
    joinReviewerAttempt.mockResolvedValue({ joined: true });
    const signIn = vi.fn();
    await run(signIn).done;
    expect(signIn).not.toHaveBeenCalled();
    expect(finalizeReadinessRun).toHaveBeenCalledTimes(1);
  });
});
