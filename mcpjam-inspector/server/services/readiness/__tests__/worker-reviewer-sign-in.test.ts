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
const getReadinessRunSubmission = vi.fn();

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
  getReadinessRunSubmission: (...args: unknown[]) =>
    getReadinessRunSubmission(...args),
  ReadinessLeaseLostError,
  ReadinessSubmissionUnreadableError,
}));

// Dynamic, after the mock: see the same note in `worker.test.ts`.
const { attemptEnding, executeHostedReadinessRun } =
  await import("../worker.js");

const LEASE = { runId: "run_1", jobId: "job_1" };
const ATTEMPT = {
  projectId: "proj_1",
  passwordSecretName: "MCPJAM_REVIEWER_ACME_PASSWORD",
  username: "review@example.com",
};
/** A submission that names no identity tool, so a connected attempt can pass. */
const SUBMISSION = {
  submissionId: "sub_1",
  submissionRevision: 1,
  flowId: "claude-connector",
  flowVersion: "2026-11-13",
  answers: [
    { key: "testLaunch.instructions", value: "Open the demo.", origin: "set" },
  ],
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
  extra: Record<string, unknown> = {},
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
      submissionId: "sub_1",
      authorizeReviewer: async (accountId: string) => ({
        accountId,
        mcpHeaders: {},
      }),
      ...extra,
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
  getReadinessRunSubmission.mockResolvedValue(SUBMISSION);
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

  it("fails the attempt when the identity check it was asked for cannot be made", async () => {
    getReadinessRunSubmission.mockResolvedValue({
      ...SUBMISSION,
      answers: [
        ...SUBMISSION.answers,
        { key: "testLaunch.identityTool", value: "whoami", origin: "set" },
        {
          key: "testLaunch.expectedIdentityPath",
          value: "$.user.email",
          origin: "set",
        },
        {
          key: "testLaunch.expectedIdentity",
          value: "review@example.com",
          origin: "set",
        },
      ],
    });
    const signIn = vi.fn(async () => ({
      kind: "connected",
      reviewerAccountId: "acct_1",
    }));
    await run(signIn).done;
    // The server lists no `whoami`, so nothing confirmed who signed in.
    expect(recordReviewerAttempt).toHaveBeenCalledWith(LEASE, "att_1", {
      outcome: "failed",
      detail: expect.stringContaining("could not confirm who it signed in as"),
    });
    expect(finalizeReadinessRun).toHaveBeenCalledTimes(1);
  });

  it("resumes the account a person connected without starting another sign-in", async () => {
    joinReviewerAttempt.mockResolvedValue({
      joined: true,
      attempt: {
        ...ATTEMPT,
        reviewerAccountId: "acct_1",
        humanSignInCompletedAt: 100,
      },
    });
    const signIn = vi.fn();
    await run(signIn).done;
    expect(signIn).not.toHaveBeenCalled();
    expect(recordReviewerAttempt).toHaveBeenCalledWith(
      LEASE,
      "att_1",
      expect.objectContaining({ outcome: "passed" }),
    );
    expect(finalizeReadinessRun).toHaveBeenCalledTimes(1);
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

describe("the account the sign-in connected", () => {
  it("is authorized mid-run and graded with, since the start could not know it", async () => {
    const signIn = vi.fn(async () => ({
      kind: "connected",
      reviewerAccountId: "acct_new",
    }));
    const authorizeReviewer = vi.fn(async () => ({
      accountId: "acct_new",
      mcpHeaders: { Authorization: "Bearer reviewer-token" },
    }));
    await run(signIn, serverFetch(), {
      reviewer: {
        missing: "No reviewer account is connected for this submission.",
      },
      authorizeReviewer,
    }).done;
    expect(authorizeReviewer).toHaveBeenCalledWith("acct_new");
  });

  it("is not authorized again when the start already had it", async () => {
    joinReviewerAttempt.mockResolvedValue({
      joined: true,
      attempt: {
        ...ATTEMPT,
        reviewerAccountId: "acct_1",
        humanSignInCompletedAt: 100,
      },
    });
    const authorizeReviewer = vi.fn();
    await run(vi.fn(), serverFetch(), {
      reviewer: { accountId: "acct_1", mcpHeaders: {} },
      authorizeReviewer,
    }).done;
    expect(authorizeReviewer).not.toHaveBeenCalled();
    expect(recordReviewerAttempt).toHaveBeenCalledWith(LEASE, "att_1", {
      outcome: "passed",
      detail: expect.stringContaining("A person signed in"),
    });
  });
});

describe("how a connected attempt ends", () => {
  const automated = { kind: "connected", reviewerAccountId: "acct_1" } as const;

  it("passes with a confirmed identity, and says so", () => {
    expect(attemptEnding(automated, { outcome: "verified", expected: { identity: "reviewer@example.com" } })).toEqual({
      outcome: "passed",
      detail: expect.stringMatching(
        /^MCPJam signed in .*identity check confirmed the reviewer\.$/,
      ),
    });
  });

  it("keeps a completed human sign-in for another identity check when the server is unavailable", () => {
    const person = { ...automated, signedInBy: "person" as const };
    expect(attemptEnding(person, { outcome: "unverified", reason: "initialize returned 503" })).toMatchObject({
      stage: { stage: "identity", status: "blocked" },
      waitingFor: { reason: expect.stringContaining("503"), action: expect.stringContaining("retry verification") },
    });
    expect(attemptEnding(person, { outcome: "wrong-account" }).outcome).toBe("failed");
  });

  it("distinguishes an organization check from an account identity check", () => {
    expect(attemptEnding(automated, {
      outcome: "verified", expected: { organization: "Example Org" },
    })).toMatchObject({
      outcome: "passed",
      detail: expect.stringContaining("organization check passed; account identity was not checked"),
    });
  });

  it("passes without an identity tool, saying the identity was not checked", () => {
    const ending = attemptEnding(automated, {
      outcome: "unverified",
      reason: "the submission names no identity tool",
      notAsked: true,
    });
    expect(ending.outcome).toBe("passed");
    expect(ending.detail).toContain(
      "names no identity tool, so the identity was not checked.",
    );
  });

  it("fails when a check that was asked for could not be made", () => {
    for (const reason of [
      "whoami failed: the tool answered with an error",
      "whoami's result has no value at $.user.email",
      "the reviewer account's session failed: 401",
      "the identity tool's arguments are not a JSON object",
    ]) {
      const ending = attemptEnding(automated, {
        outcome: "unverified",
        reason,
      });
      expect(ending).toEqual({
        outcome: "failed",
        detail: expect.stringContaining(
          `could not confirm who it signed in as: ${reason}. Fix`,
        ),
      });
    }
    // No check at all, such as an account the run could not use, fails too.
    expect(attemptEnding(automated, undefined).outcome).toBe("failed");
  });

  it("fails on another account or tenant, whoever signed in", () => {
    for (const outcome of ["wrong-account", "wrong-tenant"] as const) {
      const ending = attemptEnding(
        { ...automated, signedInBy: "person" },
        { outcome, reason: "the server named Other Org." },
      );
      expect(ending.outcome).toBe("failed");
      expect(ending.detail).toMatch(
        /^A person signed in .*: the server named Other Org\. Check/,
      );
    }
  });
});
