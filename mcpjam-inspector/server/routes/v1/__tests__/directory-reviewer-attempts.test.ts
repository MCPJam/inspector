/**
 * A submission's reviewer sign-in attempts: secret names in, never a value;
 * the backend's refusals out by status; and the readiness run that works on an
 * attempt, which carries it to the worker in memory and never to the backend
 * run, whose key comes from the attempt.
 *
 * Convex is mocked at the `convex/browser` boundary, as in the submission
 * tests. The attempt's own rules are the backend's, tested there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { CHATGPT_PLUGIN_FLOW, CLAUDE_CONNECTOR_FLOW } from "@mcpjam/sdk";

const {
  validateGuestTokenMock,
  convexQueryMock,
  convexMutationMock,
  convexActionMock,
  authorizeServerMock,
  executeHostedReadinessRunMock,
} = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  convexQueryMock: vi.fn(),
  convexMutationMock: vi.fn(),
  convexActionMock: vi.fn(),
  authorizeServerMock: vi.fn(),
  executeHostedReadinessRunMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(function () {
    return { setAuth: vi.fn(), query: convexQueryMock, mutation: convexMutationMock, action: convexActionMock };
  }),
}));
vi.mock("../../../services/readiness/worker.js", () => ({
  executeHostedReadinessRun: executeHostedReadinessRunMock,
}));
vi.mock("../../web/auth.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../web/auth.js");
  return { ...actual, authorizeServer: authorizeServerMock };
});

import v1Routes from "../index.js";
import { ErrorCode, WebRouteError } from "../../web/errors.js";

const PROJECT = "p1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SUBMISSION = "subxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const ATTEMPT_ID = "attxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SERVER = "srvxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const RUN = "runxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SUBMISSIONS = `/api/v1/projects/${PROJECT}/directory-submissions`;
const BASE = `${SUBMISSIONS}/${SUBMISSION}/reviewer-attempts`;
const ONE = `${BASE}/${ATTEMPT_ID}`;
const PASSWORD_SECRET = "MCPJAM_REVIEWER_ACME_PASSWORD";
const PASSWORD = "sk-proj-reviewerpasswordsample01";

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
  id: ATTEMPT_ID,
  submissionId: SUBMISSION,
  projectId: PROJECT,
  serverId: SERVER,
  passwordSecretName: PASSWORD_SECRET,
  username: "review@example.com",
  state: "running",
  stages: [],
  runIds: [],
  expiresAt: 100,
  createdBy: "user_1",
  createdAt: 1,
  updatedAt: 1,
};

type Handler = (args: Record<string, unknown>) => unknown;
let queries: Record<string, Handler>;
let mutations: Record<string, Handler>;

const nameOf = (ref: unknown) =>
  typeof ref === "string" ? ref : getFunctionName(ref as never);

function request(method: string, path: string, body?: unknown, token = "tok") {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return Promise.resolve(
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

function calls(name: string) {
  return convexMutationMock.mock.calls
    .filter(([ref]) => nameOf(ref) === name)
    .map(([, args]) => args as Record<string, unknown>);
}

const refuse = (data: Record<string, unknown>) => () => {
  throw new ConvexError(data);
};

describe("v1 reviewer attempts", () => {
  const originalEnv = {
    CONVEX_URL: process.env.CONVEX_URL,
    CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    convexActionMock.mockResolvedValue({ handoffUrl: "https://app.test/connect/server/one-use", expiresAt: 100 });
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    queries = {
      "directorySubmissions:getDirectorySubmission": () => ROW,
      "directoryReviewerAttempts:getDirectoryReviewerAttempt": () => ATTEMPT,
      "directoryReviewerAttempts:listDirectoryReviewerAttempts": () => [ATTEMPT],
    };
    mutations = {
      "directoryReviewerAttempts:createDirectoryReviewerAttempt": () => ATTEMPT,
      "directoryReviewerAttempts:resumeDirectoryReviewerAttempt": () => ({
        ...ATTEMPT,
        resumedAt: 99,
      }),
      "directoryReviewerAttempts:cancelDirectoryReviewerAttempt": () => ({
        ...ATTEMPT,
        state: "cancelled",
      }),
      "claudeReadinessRuns:requestReadinessRun": () => ({
        runId: RUN,
        jobId: "job_1",
        reused: false,
      }),
    };
    convexQueryMock.mockImplementation(async (ref, args) => queries[nameOf(ref)]!(args));
    convexMutationMock.mockImplementation(async (ref, args) => mutations[nameOf(ref)]!(args));
    authorizeServerMock.mockResolvedValue({
      authorized: true,
      serverConfig: { transportType: "http", url: "https://connector.example.com/mcp" },
    });
    executeHostedReadinessRunMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value) process.env[key] = value;
      else delete process.env[key];
    }
  });

  it.each([
    ["POST", BASE],
    ["GET", BASE],
    ["GET", ONE],
    ["POST", `${ONE}/resume`],
    ["POST", `${ONE}/cancel`],
  ])("denies a guest %s %s", async (method, path) => {
    validateGuestTokenMock.mockResolvedValue({ valid: true, guestId: "guest_1" });
    const res = await request(method, path, method === "GET" ? undefined : {}, "guest-jwt");
    expect(res.status).toBe(401);
    expect(convexQueryMock).not.toHaveBeenCalled();
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  describe("starting", () => {
    it("saves secret names, then starts the run, handing the attempt to the worker only", async () => {
      const res = await request("POST", BASE, {
        passwordSecretName: PASSWORD_SECRET,
        username: "review@example.com",
        loginUrl: "https://auth.example.com/login",
        idempotencyKey: "k1",
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({
        attempt: { id: ATTEMPT_ID, state: "running" },
        run: { runId: RUN, status: "pending", deduped: false },
      });
      expect(calls("directoryReviewerAttempts:createDirectoryReviewerAttempt")).toEqual([
        {
          submissionId: SUBMISSION,
          passwordSecretName: PASSWORD_SECRET,
          username: "review@example.com",
          loginUrl: "https://auth.example.com/login",
          idempotencyKey: "k1",
        },
      ]);
      const [requested] = calls("claudeReadinessRuns:requestReadinessRun");
      expect(requested).toMatchObject({
        submissionId: SUBMISSION,
        idempotencyKey: `reviewer-attempt:${ATTEMPT_ID}`,
        includeLlmObservations: false,
      });
      expect("reviewerAttemptId" in requested!).toBe(false);
      expect(executeHostedReadinessRunMock.mock.calls[0]![0]).toMatchObject({
        lease: { runId: RUN, jobId: "job_1" },
        submissionId: SUBMISSION,
        reviewerAttemptId: ATTEMPT_ID,
      });
    });

    it.each([
      ["a key the body does not take", { password: PASSWORD }],
      ["a credential-shaped username", { username: PASSWORD }],
      ["a sign-in address carrying a password", { loginUrl: `https://reviewer:${PASSWORD}@auth.example.com/` }],
      ["a token in the tenant", { tenant: `token=${PASSWORD}` }],
    ])("refuses %s and quotes nothing back", async (_case, extra) => {
      const res = await request("POST", BASE, { passwordSecretName: PASSWORD_SECRET, ...extra });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("secret names");
      expect(text).not.toContain(PASSWORD);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("takes only secrets named with the reviewer prefix", async () => {
      const res = await request("POST", BASE, { passwordSecretName: "STRIPE_API_KEY" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toContain("MCPJAM_REVIEWER_");
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("authorizes the server before anything is written", async () => {
      authorizeServerMock.mockRejectedValue(
        new WebRouteError(404, ErrorCode.NOT_FOUND, "Server not found"),
      );
      const res = await request("POST", BASE, { passwordSecretName: PASSWORD_SECRET });
      expect(res.status).toBe(404);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it.each([
      [{ code: "secret_not_found", secretName: PASSWORD_SECRET }, 400],
      [{ code: "secret_not_materialized", secretName: PASSWORD_SECRET }, 400],
      [{ code: "attempt_open", attemptId: ATTEMPT_ID }, 409],
      [{ code: "idempotency_key_reused" }, 409],
    ])("answers the backend's %o with %i and its details", async (data, status) => {
      const message = "The backend's sentence, naming what to do.";
      mutations["directoryReviewerAttempts:createDirectoryReviewerAttempt"] = refuse({ ...data, message });
      const res = await request("POST", BASE, { passwordSecretName: PASSWORD_SECRET });
      expect(res.status).toBe(status);
      const body = (await res.json()) as { message: string; details: Record<string, unknown> };
      expect(body.message).toBe(message);
      expect(body.details).toEqual(data);
      expect(executeHostedReadinessRunMock).not.toHaveBeenCalled();
    });

    it("answers the beta gate with 403", async () => {
      mutations["directoryReviewerAttempts:createDirectoryReviewerAttempt"] = refuse({
        code: "FEATURE_UNAVAILABLE",
        feature: "directory-readiness",
        message: "Directory readiness is not available for your organization.",
      });
      const res = await request("POST", BASE, { passwordSecretName: PASSWORD_SECRET });
      expect(res.status).toBe(403);
    });

    it("on a replay, finds the run the first start began, and starts nothing for an ended attempt", async () => {
      mutations["directoryReviewerAttempts:createDirectoryReviewerAttempt"] = () => ({ ...ATTEMPT, replayed: true });
      mutations["claudeReadinessRuns:requestReadinessRun"] = () => ({ runId: RUN, jobId: "job_1", reused: true });
      queries["claudeReadinessRuns:getReadinessRun"] = () => ({ status: "running" });
      const res = await request("POST", BASE, { passwordSecretName: PASSWORD_SECRET, idempotencyKey: "k1" });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ replayed: true, run: { runId: RUN, deduped: true, status: "running" } });
      expect(executeHostedReadinessRunMock).not.toHaveBeenCalled();

      convexMutationMock.mockClear();
      mutations["directoryReviewerAttempts:createDirectoryReviewerAttempt"] = () => ({
        ...ATTEMPT,
        state: "passed",
        replayed: true,
      });
      const ended = await request("POST", BASE, { passwordSecretName: PASSWORD_SECRET, idempotencyKey: "k1" });
      expect(await ended.json()).toMatchObject({ run: null, attempt: { state: "passed" } });
      expect(calls("claudeReadinessRuns:requestReadinessRun")).toEqual([]);
    });

    it("names the attempt it kept open when its run cannot start", async () => {
      mutations["claudeReadinessRuns:requestReadinessRun"] = refuse({
        code: "submission_mismatch",
        message: "This submission is for a different server. Start the run against the submission's server.",
      });
      const res = await request("POST", BASE, { passwordSecretName: PASSWORD_SECRET });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { details: Record<string, unknown> };
      expect(body.details.attemptId).toBe(ATTEMPT_ID);
    });
  });

  describe("reading", () => {
    it("lists a submission's attempts, forwarding the limit, and refuses one outside 1 to 50", async () => {
      queries["directoryReviewerAttempts:listDirectoryReviewerAttempts"] = (args) => {
        expect(args).toEqual({ submissionId: SUBMISSION, limit: 5 });
        return [ATTEMPT];
      };
      const res = await request("GET", `${BASE}?limit=5`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ items: [ATTEMPT] });
      expect((await request("GET", `${BASE}?limit=51`)).status).toBe(400);
    });

    it("lists nothing for another project's submission", async () => {
      queries["directorySubmissions:getDirectorySubmission"] = () => ({ ...ROW, projectId: "p2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
      expect((await request("GET", BASE)).status).toBe(404);
    });

    it("reads one attempt, and 404s another submission's", async () => {
      const res = await request("GET", ONE);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(ATTEMPT);
      queries["directoryReviewerAttempts:getDirectoryReviewerAttempt"] = () => ({
        ...ATTEMPT,
        submissionId: "subotherxxxxxxxxxxxxxxxxxxxxxxxx",
      });
      expect((await request("GET", ONE)).status).toBe(404);
      queries["directoryReviewerAttempts:getDirectoryReviewerAttempt"] = () => null;
      expect((await request("GET", ONE)).status).toBe(404);
    });
  });

  describe("a human sign-in handoff", () => {
    it("mints the link only after reading the attempt in the requested submission", async () => {
      const response = await request("POST", `${ONE}/handoff`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ handoffUrl: "https://app.test/connect/server/one-use" });
      expect(convexActionMock).toHaveBeenCalledWith(expect.anything(), { attemptId: ATTEMPT_ID });
      expect(nameOf(convexActionMock.mock.calls[0]![0])).toBe("directoryReviewerHandoff:createReviewerHandoff");
    });

    it("refuses a handoff for an attempt in another submission", async () => {
      queries["directoryReviewerAttempts:getDirectoryReviewerAttempt"] = () => ({ ...ATTEMPT, submissionId: "other" });
      expect((await request("POST", `${ONE}/handoff`)).status).toBe(404);
      expect(convexActionMock).not.toHaveBeenCalled();
    });

    it("refuses caller-supplied handoff data", async () => {
      expect((await request("POST", `${ONE}/handoff`, { token: "chosen-token" })).status).toBe(400);
      expect(convexActionMock).not.toHaveBeenCalled();
    });
  });

  describe("resuming and cancelling", () => {
    it("resumes a waiting attempt and starts its next run, keyed by the resume", async () => {
      queries["directoryReviewerAttempts:getDirectoryReviewerAttempt"] = () => ({
        ...ATTEMPT,
        state: "waiting-for-person",
      });
      const res = await request("POST", `${ONE}/resume`);
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ attempt: { id: ATTEMPT_ID }, run: { runId: RUN } });
      expect(calls("directoryReviewerAttempts:resumeDirectoryReviewerAttempt")).toEqual([{ attemptId: ATTEMPT_ID }]);
      expect(calls("claudeReadinessRuns:requestReadinessRun")[0]).toMatchObject({
        idempotencyKey: `reviewer-attempt:${ATTEMPT_ID}:99`,
      });
      expect(executeHostedReadinessRunMock.mock.calls[0]![0]).toMatchObject({ reviewerAttemptId: ATTEMPT_ID });
    });

    it("answers an attempt that is not waiting with 409 and its state, starting nothing", async () => {
      mutations["directoryReviewerAttempts:resumeDirectoryReviewerAttempt"] = refuse({
        code: "attempt_not_waiting",
        state: "running",
        message: "This attempt is already running, so there is nothing to resume. Wait for its run to finish.",
      });
      const res = await request("POST", `${ONE}/resume`);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { details: unknown }).details).toEqual({
        code: "attempt_not_waiting",
        state: "running",
      });
      expect(executeHostedReadinessRunMock).not.toHaveBeenCalled();
    });

    it("refuses any body on resume and cancel", async () => {
      for (const action of ["resume", "cancel"]) {
        const res = await request("POST", `${ONE}/${action}`, { password: PASSWORD });
        expect(res.status).toBe(400);
        expect(await res.text()).not.toContain(PASSWORD);
      }
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("cancels an attempt of this submission, and nothing of another's", async () => {
      const res = await request("POST", `${ONE}/cancel`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: ATTEMPT_ID, state: "cancelled" });
      convexMutationMock.mockClear();
      queries["directoryReviewerAttempts:getDirectoryReviewerAttempt"] = () => ({
        ...ATTEMPT,
        projectId: "p2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      });
      expect((await request("POST", `${ONE}/cancel`)).status).toBe(404);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });

  describe("a ChatGPT plugin submission", () => {
    const PLUGIN_VERSION = "pvxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const PLUGIN_ROW = {
      ...ROW,
      directory: "openai",
      flowId: CHATGPT_PLUGIN_FLOW.id,
      flowVersion: CHATGPT_PLUGIN_FLOW.version,
      pluginId: "plgxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      pluginVersionId: PLUGIN_VERSION,
    };

    it("starts and resumes its attempt's run on the plugin version saved on the submission", async () => {
      queries["directorySubmissions:getDirectorySubmission"] = () => PLUGIN_ROW;
      queries["directoryReviewerAttempts:getDirectoryReviewerAttempt"] =
        () => ({ ...ATTEMPT, state: "waiting-for-person" });
      const started = await request("POST", BASE, {
        passwordSecretName: PASSWORD_SECRET,
      });
      expect(started.status).toBe(201);
      expect((await request("POST", `${ONE}/resume`)).status).toBe(202);
      const graded = {
        readinessKind: "openai",
        submissionMode: "mcp-uploaded-skills",
        pluginVersionId: PLUGIN_VERSION,
      };
      expect(calls("claudeReadinessRuns:requestReadinessRun")).toEqual([
        expect.objectContaining(graded),
        expect.objectContaining(graded),
      ]);
    });

    it("refuses one with no saved version before any attempt is created or resumed", async () => {
      queries["directorySubmissions:getDirectorySubmission"] = () => ({
        ...PLUGIN_ROW,
        pluginVersionId: undefined,
      });
      for (const [path, body] of [
        [BASE, { passwordSecretName: PASSWORD_SECRET }],
        [`${ONE}/resume`, undefined],
      ] as const) {
        const res = await request("POST", path, body);
        expect(res.status).toBe(400);
        const { message } = (await res.json()) as { message: string };
        expect(message).toContain("no plugin version saved");
      }
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });

  describe("a submission run with an attempt", () => {
    it("carries a running attempt of this submission to the worker, never to the backend run", async () => {
      const res = await request("POST", `${SUBMISSIONS}/${SUBMISSION}/runs`, { reviewerAttemptId: ATTEMPT_ID });
      expect(res.status).toBe(202);
      expect("reviewerAttemptId" in calls("claudeReadinessRuns:requestReadinessRun")[0]!).toBe(false);
      expect(executeHostedReadinessRunMock.mock.calls[0]![0]).toMatchObject({ reviewerAttemptId: ATTEMPT_ID });
    });

    it.each([
      ["waiting-for-person", /Resume it/],
      ["cancelled", /Start a new attempt/],
    ])("refuses an attempt that is %s, starting nothing", async (state, copy) => {
      queries["directoryReviewerAttempts:getDirectoryReviewerAttempt"] = () => ({ ...ATTEMPT, state });
      const res = await request("POST", `${SUBMISSIONS}/${SUBMISSION}/runs`, { reviewerAttemptId: ATTEMPT_ID });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { message: string }).message).toMatch(copy);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });
});
