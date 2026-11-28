/**
 * Which reviewer account a submission run signs in as: the one the newest
 * reviewer attempt connected, authorized as itself with the caller's bearer
 * and handed to the worker beside, never instead of, the caller's own
 * account. Without one the worker gets the reason, and the run still starts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { getFunctionName } from "convex/server";
import { CLAUDE_CONNECTOR_FLOW } from "@mcpjam/sdk";

const {
  validateGuestTokenMock,
  convexQueryMock,
  convexMutationMock,
  authorizeServerMock,
  executeHostedReadinessRunMock,
} = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  convexQueryMock: vi.fn(),
  convexMutationMock: vi.fn(),
  authorizeServerMock: vi.fn(),
  executeHostedReadinessRunMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(function () {
    return {
      setAuth: vi.fn(),
      query: convexQueryMock,
      mutation: convexMutationMock,
    };
  }),
}));
vi.mock("../../../services/readiness/worker.js", () => ({
  executeHostedReadinessRun: executeHostedReadinessRunMock,
}));
vi.mock("../../web/auth.js", async () => {
  const actual =
    await vi.importActual<Record<string, unknown>>("../../web/auth.js");
  return { ...actual, authorizeServer: authorizeServerMock };
});

import v1Routes from "../index.js";

const PROJECT = "p1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SUBMISSION = "subxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SERVER = "srvxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SUBMISSIONS = `/api/v1/projects/${PROJECT}/directory-submissions`;
const RUNS = `${SUBMISSIONS}/${SUBMISSION}/runs`;
const ATTEMPTS = `${SUBMISSIONS}/${SUBMISSION}/reviewer-attempts`;
const CONFIG = {
  transportType: "http",
  url: "https://connector.example.com/mcp",
};

const ROW = {
  id: SUBMISSION,
  projectId: PROJECT,
  serverId: SERVER,
  directory: "claude",
  flowId: "claude-connector",
  flowVersion: CLAUDE_CONNECTOR_FLOW.version,
  answers: [],
  revision: 1,
  createdBy: "user_1",
  createdAt: 1,
  updatedAt: 1,
};
const ATTEMPT = {
  id: "attxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  submissionId: SUBMISSION,
  projectId: PROJECT,
  serverId: SERVER,
  passwordSecretName: "MCPJAM_REVIEWER_SAMPLE_PASSWORD",
  state: "running",
  stages: [],
  runIds: [],
  expiresAt: 100,
  createdBy: "user_1",
  createdAt: 1,
  updatedAt: 1,
};

let attempts: unknown[];

const nameOf = (ref: unknown) =>
  typeof ref === "string" ? ref : getFunctionName(ref as never);

function request(path: string, body: unknown) {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer tok",
    },
    body: JSON.stringify(body),
  });
}

function workerOptions() {
  return executeHostedReadinessRunMock.mock.calls[0]![0] as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CONVEX_URL = "https://convex.example.com";
  process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
  validateGuestTokenMock.mockResolvedValue({ valid: false });
  attempts = [
    { ...ATTEMPT, state: "passed", reviewerAccountId: "acct_reviewer" },
  ];
  const queries: Record<string, () => unknown> = {
    "directorySubmissions:getDirectorySubmission": () => ROW,
    "directoryReviewerAttempts:listDirectoryReviewerAttempts": () => attempts,
  };
  const mutations: Record<string, () => unknown> = {
    "directoryReviewerAttempts:createDirectoryReviewerAttempt": () => ATTEMPT,
    "claudeReadinessRuns:requestReadinessRun": () => ({
      runId: "runxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      jobId: "job_1",
      reused: false,
    }),
  };
  convexQueryMock.mockImplementation(async (ref) => queries[nameOf(ref)]!());
  convexMutationMock.mockImplementation(async (ref) =>
    mutations[nameOf(ref)]!(),
  );
  authorizeServerMock.mockImplementation(
    async (
      _c,
      _token,
      _project,
      _server,
      options?: { connectionId?: string },
    ) => ({
      authorized: true,
      serverConfig: CONFIG,
      oauthAccessToken: options?.connectionId
        ? "reviewer-token"
        : "staff-token",
    }),
  );
  executeHostedReadinessRunMock.mockResolvedValue(undefined);
});

describe("a submission run's reviewer account", () => {
  it("is the one the newest attempt connected, authorized as itself beside the caller's", async () => {
    const res = await request(RUNS, {});
    expect(res.status).toBe(202);
    expect(authorizeServerMock).toHaveBeenCalledWith(
      expect.anything(),
      "tok",
      PROJECT,
      SERVER,
      { connectionId: "acct_reviewer" },
    );
    expect(workerOptions()).toMatchObject({
      mcpHeaders: { authorization: "Bearer staff-token" },
      reviewer: {
        accountId: "acct_reviewer",
        mcpHeaders: { authorization: "Bearer reviewer-token" },
      },
    });
  });

  it("is missing, with the reason, when no attempt connected one", async () => {
    attempts = [ATTEMPT];
    const res = await request(RUNS, {});
    expect(res.status).toBe(202);
    expect(authorizeServerMock).toHaveBeenCalledTimes(1);
    expect(workerOptions().reviewer).toEqual({
      missing:
        "No reviewer account is connected for this submission. Rehearse the reviewer sign-in, then run again.",
    });
  });

  it("is missing, and the run still starts, when the account cannot be used", async () => {
    authorizeServerMock.mockImplementation(async (...args: unknown[]) => {
      if (args[4]) throw new Error("Authorization failed (403)");
      return {
        authorized: true,
        serverConfig: CONFIG,
        oauthAccessToken: "staff-token",
      };
    });
    const res = await request(RUNS, {});
    expect(res.status).toBe(202);
    expect(workerOptions().reviewer).toEqual({
      missing:
        "MCPJam could not use the reviewer account (Authorization failed (403)). Rehearse the reviewer sign-in again, then run again.",
    });
  });

  it("is missing when the account holds no sign-in", async () => {
    authorizeServerMock.mockResolvedValue({
      authorized: true,
      serverConfig: CONFIG,
    });
    await request(RUNS, {});
    expect(workerOptions().reviewer).toEqual({
      missing:
        "The reviewer account has no working sign-in. Rehearse the reviewer sign-in again, then run again.",
    });
  });

  it("goes with an attempt's own run too", async () => {
    attempts = [ATTEMPT];
    const res = await request(ATTEMPTS, {
      passwordSecretName: "MCPJAM_REVIEWER_SAMPLE_PASSWORD",
    });
    expect(res.status).toBe(201);
    expect(workerOptions()).toMatchObject({
      reviewerAttemptId: ATTEMPT.id,
      reviewer: {
        missing: expect.stringContaining("No reviewer account is connected"),
      },
    });
  });
});
