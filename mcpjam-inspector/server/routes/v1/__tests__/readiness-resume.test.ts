/**
 * Resuming a re-queued readiness run, and the `resumable` flag the run reads
 * carry.
 *
 * Convex is mocked at the `convex/browser` boundary, so these prove the
 * gateway: that the resume goes out with the caller's bearer and nothing
 * else, that the backend's refusals reach the caller as refusals, that the
 * server is authorized again before anything dials, and that the worker runs
 * on the lease the backend handed back without claiming it a second time.
 * Who may resume is the backend's decision, tested there.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";

const {
  validateGuestTokenMock,
  convexQueryMock,
  convexMutationMock,
  authorizeServerMock,
  executeHostedReadinessRunMock,
  failReadinessRunMock,
} = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  convexQueryMock: vi.fn(),
  convexMutationMock: vi.fn(),
  authorizeServerMock: vi.fn(),
  executeHostedReadinessRunMock: vi.fn(),
  failReadinessRunMock: vi.fn(),
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
vi.mock("../../../services/readiness/backend-client.js", async () => ({
  ...(await vi.importActual<Record<string, unknown>>(
    "../../../services/readiness/backend-client.js",
  )),
  failReadinessRun: failReadinessRunMock,
}));
vi.mock("../../web/auth.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../../web/auth.js",
  );
  return { ...actual, authorizeServer: authorizeServerMock };
});

import v1Routes from "../index.js";
import { ErrorCode, WebRouteError } from "../../web/errors.js";

const PROJECT = "p1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const RUN = "runxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const URL_SAVED = "https://connector.example.com/mcp";
const RESUME = `/api/v1/projects/${PROJECT}/readiness-runs/${RUN}/resume`;
const RESUMED_LEASE = { runId: RUN, jobId: "job_2" };

const RUN_ROW = {
  id: RUN,
  readinessKind: "claude",
  serverUrl: URL_SAVED,
  status: "pending",
  resumable: true,
  attemptCount: 2,
  submissionId: null,
  createdAt: 1,
  updatedAt: 2,
};

const RESUMED = {
  runId: RUN,
  jobId: "job_2",
  attemptCount: 2,
  readinessKind: "claude",
  projectId: PROJECT,
  serverId: "s1",
  serverUrl: URL_SAVED,
  options: {
    includeLlmObservations: true,
    lazyAuthProbe: { enabled: true, publicToolName: "search_docs" },
    claimedFeatures: [],
  },
};

const AUTHORIZED = {
  authorized: true,
  serverConfig: { transportType: "http", url: URL_SAVED },
  oauthAccessToken: "saved-token",
};

type Handler = (args: Record<string, unknown>) => unknown;
let queries: Record<string, Handler>;
let mutations: Record<string, Handler>;

function nameOf(ref: unknown): string {
  return typeof ref === "string" ? ref : getFunctionName(ref as never);
}

function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return Promise.resolve(
    app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer tok",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

function resumeCalls() {
  return convexMutationMock.mock.calls.filter(
    ([ref]) => nameOf(ref) === "readinessRunClaims:resumeReadinessRun",
  );
}

describe("v1 readiness resume", () => {
  const originalEnv = {
    CONVEX_URL: process.env.CONVEX_URL,
    CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    queries = { "claudeReadinessRuns:getReadinessRun": () => RUN_ROW };
    mutations = { "readinessRunClaims:resumeReadinessRun": () => RESUMED };
    convexQueryMock.mockImplementation(async (ref, args) =>
      queries[nameOf(ref)]!(args),
    );
    convexMutationMock.mockImplementation(async (ref, args) =>
      mutations[nameOf(ref)]!(args),
    );
    authorizeServerMock.mockResolvedValue(AUTHORIZED);
    executeHostedReadinessRunMock.mockResolvedValue(undefined);
    failReadinessRunMock.mockResolvedValue({ applied: true });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value) process.env[key] = value;
      else delete process.env[key];
    }
  });

  it("resumes, authorizes the server again, and runs on the new lease without a second claim", async () => {
    const res = await request("POST", RESUME);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      runId: RUN,
      projectId: PROJECT,
      serverId: "s1",
      readinessKind: "claude",
      status: "running",
      deduped: false,
      includeLlmObservations: true,
    });

    expect(resumeCalls()).toHaveLength(1);
    expect(resumeCalls()[0]![1]).toEqual({ runId: RUN });
    // The server the backend named, under the run's own project.
    const [, bearer, projectId, serverId] = authorizeServerMock.mock.calls[0]!;
    expect([bearer, projectId, serverId]).toEqual(["tok", PROJECT, "s1"]);

    expect(executeHostedReadinessRunMock).toHaveBeenCalledTimes(1);
    const execution = executeHostedReadinessRunMock.mock.calls[0]![0];
    expect(execution).toMatchObject({
      lease: RESUMED_LEASE,
      leaseClaimed: true,
      publisher: "claude",
      target: URL_SAVED,
      includeLlmObservations: true,
      lazyAuthProbe: { enabled: true, publicToolName: "search_docs" },
      mcpHeaders: { authorization: "Bearer saved-token" },
    });
    // Forwarded as a start forwards them: only what the requester asked for.
    expect("claimedFeatures" in execution).toBe(false);
    expect("submissionId" in execution).toBe(false);
    expect(failReadinessRunMock).not.toHaveBeenCalled();
  });

  it("grades a submission run's frozen answers", async () => {
    queries["claudeReadinessRuns:getReadinessRun"] = () => ({
      ...RUN_ROW,
      submissionId: "sub_1",
    });
    expect((await request("POST", RESUME)).status).toBe(202);
    expect(executeHostedReadinessRunMock.mock.calls[0]![0]).toMatchObject({
      submissionId: "sub_1",
    });
  });

  it("hands a resumed run the reviewer attempt that names it, and only that", async () => {
    // The node that held the attempt in memory stopped; the attempt names the run.
    queries["claudeReadinessRuns:getReadinessRun"] = () => ({
      ...RUN_ROW,
      submissionId: "sub_1",
    });
    let newest = { id: "att_1", currentRunId: RUN };
    queries["directoryReviewerAttempts:listDirectoryReviewerAttempts"] = (args) => {
      expect(args).toEqual({ submissionId: "sub_1", limit: 1 });
      return [newest];
    };
    expect((await request("POST", RESUME)).status).toBe(202);
    expect(executeHostedReadinessRunMock.mock.calls[0]![0]).toMatchObject({
      reviewerAttemptId: "att_1",
    });

    newest = { id: "att_1", currentRunId: "run_other" };
    executeHostedReadinessRunMock.mockClear();
    expect((await request("POST", RESUME)).status).toBe(202);
    const execution = executeHostedReadinessRunMock.mock.calls[0]![0];
    expect("reviewerAttemptId" in execution).toBe(false);
  });

  it("authorizes a resumed submission run's reviewer account as itself again", async () => {
    queries["claudeReadinessRuns:getReadinessRun"] = () => ({
      ...RUN_ROW,
      submissionId: "sub_1",
    });
    queries["directoryReviewerAttempts:listDirectoryReviewerAttempts"] = () => [
      { id: "att_1", currentRunId: "run_other", reviewerAccountId: "acct_reviewer" },
    ];
    authorizeServerMock.mockImplementation(
      async (_c, _token, _project, _server, options?: { connectionId?: string }) => ({
        ...AUTHORIZED,
        oauthAccessToken: options?.connectionId ? "reviewer-token" : "saved-token",
      }),
    );
    expect((await request("POST", RESUME)).status).toBe(202);
    expect(authorizeServerMock.mock.calls[1]!.slice(1)).toEqual([
      "tok",
      PROJECT,
      "s1",
      { connectionId: "acct_reviewer" },
    ]);
    expect(executeHostedReadinessRunMock.mock.calls[0]![0]).toMatchObject({
      mcpHeaders: { authorization: "Bearer saved-token" },
      reviewer: {
        accountId: "acct_reviewer",
        mcpHeaders: { authorization: "Bearer reviewer-token" },
      },
    });
  });

  it("asks for no reviewer account on a resumed run that grades no submission", async () => {
    expect((await request("POST", RESUME)).status).toBe(202);
    expect(authorizeServerMock).toHaveBeenCalledTimes(1);
    expect("reviewer" in executeHostedReadinessRunMock.mock.calls[0]![0]).toBe(false);
  });

  it("takes `{}` as no body, and refuses any field", async () => {
    expect((await request("POST", RESUME, {})).status).toBe(202);
    vi.clearAllMocks();
    const res = await request("POST", RESUME, { jobId: "job_9" });
    expect(res.status).toBe(400);
    expect(resumeCalls()).toHaveLength(0);
  });

  it("answers an unknown run with a 404 and resumes nothing", async () => {
    queries["claudeReadinessRuns:getReadinessRun"] = () => null;
    expect((await request("POST", RESUME)).status).toBe(404);
    expect(resumeCalls()).toHaveLength(0);
  });

  it("refuses a caller who did not start the run, with the backend's sentence", async () => {
    const message =
      "No readiness run you can resume was found. Start a new run instead.";
    mutations["readinessRunClaims:resumeReadinessRun"] = () => {
      throw new ConvexError({ kind: "forbidden", refusal: "membership", message });
    };
    const res = await request("POST", RESUME);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toBe(message);
    expect(authorizeServerMock).not.toHaveBeenCalled();
    expect(executeHostedReadinessRunMock).not.toHaveBeenCalled();
    expect(failReadinessRunMock).not.toHaveBeenCalled();
  });

  it.each(["already_claimed", "not_resumable"])(
    "answers 409 when the backend says %s",
    async (code) => {
      mutations["readinessRunClaims:resumeReadinessRun"] = () => {
        throw new ConvexError({ code, message: "This run is not waiting." });
      };
      const res = await request("POST", RESUME);
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, any>;
      expect(body.code).toBe("CONFLICT");
      expect(body.details.code).toBe(code);
      expect(executeHostedReadinessRunMock).not.toHaveBeenCalled();
    },
  );

  it("fails the run, and sends no credential, when the server's address changed", async () => {
    authorizeServerMock.mockResolvedValue({
      ...AUTHORIZED,
      serverConfig: { transportType: "http", url: "https://moved.example.com/mcp" },
    });
    const res = await request("POST", RESUME);
    expect(res.status).toBe(409);
    expect(executeHostedReadinessRunMock).not.toHaveBeenCalled();
    expect(failReadinessRunMock).toHaveBeenCalledWith(
      RESUMED_LEASE,
      "server_changed",
      expect.stringMatching(/address changed/),
    );
  });

  it("fails the run when the server can no longer be authorized", async () => {
    authorizeServerMock.mockRejectedValue(
      new WebRouteError(404, ErrorCode.NOT_FOUND, "Server not found"),
    );
    const res = await request("POST", RESUME);
    expect(res.status).toBe(404);
    expect(executeHostedReadinessRunMock).not.toHaveBeenCalled();
    expect(failReadinessRunMock).toHaveBeenCalledWith(
      RESUMED_LEASE,
      "server_unauthorized",
      expect.any(String),
    );
  });

  it("fails the run when it has no saved server", async () => {
    mutations["readinessRunClaims:resumeReadinessRun"] = () => ({
      ...RESUMED,
      serverId: undefined,
    });
    expect((await request("POST", RESUME)).status).toBe(409);
    expect(authorizeServerMock).not.toHaveBeenCalled();
    expect(failReadinessRunMock).toHaveBeenCalledWith(
      RESUMED_LEASE,
      "server_missing",
      expect.any(String),
    );
  });
});

describe("v1 readiness run reads report `resumable`", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
  });

  async function readWith(row: Record<string, unknown>) {
    convexQueryMock.mockResolvedValue(row);
    const res = await request(
      "GET",
      `/api/v1/projects/${PROJECT}/readiness-runs/${RUN}`,
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { resumable: unknown }).resumable;
  }

  it("is true only for a pending run the backend marks resumable", async () => {
    expect(await readWith(RUN_ROW)).toBe(true);
    expect(await readWith({ ...RUN_ROW, status: "running" })).toBe(false);
    expect(await readWith({ ...RUN_ROW, resumable: false })).toBe(false);
  });

  it("is false when the backend does not report it", async () => {
    const { resumable: _omitted, ...older } = RUN_ROW;
    expect(await readWith(older)).toBe(false);
  });

  it("is a read: nothing is resumed by reading", async () => {
    await readWith(RUN_ROW);
    expect(convexMutationMock).not.toHaveBeenCalled();
    expect(executeHostedReadinessRunMock).not.toHaveBeenCalled();
  });

  it("is on every row of a list", async () => {
    convexQueryMock.mockResolvedValue([
      RUN_ROW,
      { ...RUN_ROW, id: "run_2", status: "completed", resumable: false },
    ]);
    const res = await request(
      "GET",
      `/api/v1/projects/${PROJECT}/readiness-runs`,
    );
    const page = (await res.json()) as { items: { resumable: boolean }[] };
    expect(page.items.map((run) => run.resumable)).toEqual([true, false]);
  });
});
