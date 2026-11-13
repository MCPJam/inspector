/**
 * The public directory submission surface: what a caller may write, what a
 * read derives, and where a run's findings land.
 *
 * Convex is mocked at the `convex/browser` boundary and the report fetch at
 * `fetch`, as in the readiness tests, so these prove the GATEWAY's behaviour
 * and the args it forwards. The backend's own guard, gate and bounds are
 * tested in the backend.
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
  const actual = await vi.importActual<Record<string, unknown>>(
    "../../web/auth.js",
  );
  return { ...actual, authorizeServer: authorizeServerMock };
});

import v1Routes from "../index.js";

const PROJECT = "p1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SUBMISSION = "subxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SERVER = "srvxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const RUN = "runxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const VERSION = CLAUDE_CONNECTOR_FLOW.version;
const BASE = `/api/v1/projects/${PROJECT}/directory-submissions`;

const ROW = {
  id: SUBMISSION,
  projectId: PROJECT,
  serverId: SERVER,
  directory: "claude",
  flowId: "claude-connector",
  flowVersion: VERSION,
  answers: [
    {
      key: "listing.oneLiner",
      value: "Search Acme's product docs",
      origin: "set",
      setBy: "user_1",
      setVia: "web",
      setAt: 10,
      revision: 2,
      wordingRevision: VERSION,
    },
    {
      key: "company.contactEmail",
      value: "review@example.com",
      origin: "account",
      setAt: 5,
      revision: 1,
      wordingRevision: VERSION,
    },
  ],
  revision: 3,
  createdBy: "user_1",
  createdAt: 5,
  updatedAt: 10,
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
  opts: {
    body?: unknown;
    token?: string | null;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const { body, token = "tok" } = opts;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...opts.headers,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return Promise.resolve(
    app.request(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

function mutationArgs(name: string): Record<string, unknown> {
  const call = convexMutationMock.mock.calls.find(
    ([ref]) => nameOf(ref) === name,
  );
  expect(call, `${name} was not called`).toBeDefined();
  return call![1] as Record<string, unknown>;
}

function finding(id: string, status: string) {
  return {
    id,
    title: id,
    lane: "submission-artifacts",
    class: "required",
    status,
    source: {},
    provenance: "declared",
    intrusiveness: "passive",
    evaluatedAt: "2026-11-13T00:00:00.000Z",
    engineVersion: "test",
  };
}

function stubReport(report: unknown, status = 200) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(report), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("v1 directory submissions", () => {
  const originalEnv = {
    CONVEX_URL: process.env.CONVEX_URL,
    CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
    INSPECTOR_SERVICE_TOKEN: process.env.INSPECTOR_SERVICE_TOKEN,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    queries = {
      "directorySubmissions:getDirectorySubmission": () => ROW,
      "users:getCurrentUser": () => ({
        name: "Sample Person",
        email: "review@example.com",
      }),
      "projects:getProjectCapabilities": () => ({ organizationId: "org_1" }),
      "organizations:getOrganization": () => ({ name: "Acme" }),
    };
    mutations = {};
    convexQueryMock.mockImplementation(async (ref, args) => {
      const handler = queries[nameOf(ref)];
      if (!handler) throw new Error(`unexpected query ${nameOf(ref)}`);
      return handler(args);
    });
    convexMutationMock.mockImplementation(async (ref, args) => {
      const handler = mutations[nameOf(ref)];
      if (!handler) throw new Error(`unexpected mutation ${nameOf(ref)}`);
      return handler(args);
    });
    authorizeServerMock.mockResolvedValue({
      authorized: true,
      serverConfig: {
        transportType: "http",
        url: "https://connector.example.com/mcp",
      },
    });
    executeHostedReadinessRunMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value) process.env[key] = value;
      else delete process.env[key];
    }
  });

  describe("auth", () => {
    it.each([
      ["GET", "/api/v1/directory-flows"],
      ["GET", BASE],
      ["POST", BASE],
      ["PATCH", `${BASE}/${SUBMISSION}`],
      ["POST", `${BASE}/${SUBMISSION}/runs`],
      ["GET", `${BASE}/${SUBMISSION}/results`],
    ])("denies a guest %s %s", async (method, path) => {
      validateGuestTokenMock.mockResolvedValue({
        valid: true,
        guestId: "guest_1",
      });
      const res = await request(method, path, {
        token: "guest-jwt",
        body: method === "GET" ? undefined : {},
      });
      expect(res.status).toBe(401);
      expect(convexQueryMock).not.toHaveBeenCalled();
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });

  describe("flows", () => {
    it("lists each flow with its steps and no fields", async () => {
      const res = await request("GET", "/api/v1/directory-flows");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<Record<string, any>> };
      expect(body.items).toEqual([
        expect.objectContaining({
          id: "claude-connector",
          directory: "claude",
          version: VERSION,
          submissionUrl: CLAUDE_CONNECTOR_FLOW.submissionUrl,
        }),
        expect.objectContaining({
          id: "chatgpt-plugin",
          directory: "openai",
          version: CHATGPT_PLUGIN_FLOW.version,
          submissionUrl: CHATGPT_PLUGIN_FLOW.submissionUrl,
        }),
      ]);
      expect(body.items[0]!.steps[0]).toEqual({
        id: "connection",
        title: CLAUDE_CONNECTOR_FLOW.steps[0]!.title,
      });
    });

    it("returns one whole flow, and 404s one that does not exist", async () => {
      const res = await request("GET", "/api/v1/directory-flows/claude-connector");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(
        JSON.parse(JSON.stringify(CLAUDE_CONNECTOR_FLOW)),
      );
      const missing = await request("GET", "/api/v1/directory-flows/nope");
      expect(missing.status).toBe(404);
    });
  });

  describe("creating", () => {
    beforeEach(() => {
      mutations["directorySubmissions:createDirectorySubmission"] = () => ({
        submissionId: SUBMISSION,
        revision: 1,
        reused: false,
      });
    });

    it("stores the account's facts as prefills and derives defaults on read", async () => {
      const res = await request("POST", BASE, {
        body: { flowId: "claude-connector", serverId: SERVER },
      });
      expect(res.status).toBe(201);
      const args = mutationArgs("directorySubmissions:createDirectorySubmission");
      expect(args).toMatchObject({
        projectId: PROJECT,
        serverId: SERVER,
        flowId: "claude-connector",
        flowVersion: VERSION,
      });
      // Defaults are never stored: only the three account facts go in.
      expect(args.prefill).toEqual([
        { key: "company.name", value: "Acme", wordingRevision: VERSION },
        { key: "company.contactName", value: "Sample Person", wordingRevision: VERSION },
        { key: "company.contactEmail", value: "review@example.com", wordingRevision: VERSION },
      ]);

      const view = (await res.json()) as Record<string, any>;
      expect(view.answers).toContainEqual(
        expect.objectContaining({ key: "company.contactEmail", origin: "account" }),
      );
      expect(view.answers).toContainEqual({
        key: "useCases.access",
        value: "read-only",
        origin: "default",
      });
      expect(view.submissionUrl).toBe(CLAUDE_CONNECTOR_FLOW.submissionUrl);
      expect(view.steps).toHaveLength(CLAUDE_CONNECTOR_FLOW.steps.length);
      expect(view.resultsRunId).toBeNull();
    });

    it("leaves a prefill empty when its value cannot be read", async () => {
      queries["organizations:getOrganization"] = () => {
        throw new Error("convex is down");
      };
      queries["users:getCurrentUser"] = () => ({ name: "", email: "review@example.com" });
      const res = await request("POST", BASE, {
        body: { flowId: "claude-connector", serverId: SERVER },
      });
      expect(res.status).toBe(201);
      const args = mutationArgs("directorySubmissions:createDirectorySubmission");
      expect(args.prefill).toEqual([
        { key: "company.contactEmail", value: "review@example.com", wordingRevision: VERSION },
      ]);
    });

    it("says when an idempotency key answered from an earlier create", async () => {
      mutations["directorySubmissions:createDirectorySubmission"] = () => ({
        submissionId: SUBMISSION,
        revision: 3,
        reused: true,
      });
      const res = await request("POST", BASE, {
        body: { flowId: "claude-connector", serverId: SERVER, idempotencyKey: "k1" },
      });
      expect(((await res.json()) as { replayed?: boolean }).replayed).toBe(true);
      expect(
        mutationArgs("directorySubmissions:createDirectorySubmission").idempotencyKey,
      ).toBe("k1");
    });

    it.each([
      ["an unknown key", { flowId: "claude-connector", serverId: SERVER, answers: {} }],
      ["a missing server", { flowId: "claude-connector" }],
      ["a flow that does not exist", { flowId: "nope", serverId: SERVER }],
    ])("refuses %s before anything is written", async (_label, body) => {
      const res = await request("POST", BASE, { body });
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });

  describe("reading", () => {
    it("validates the stored answers against the flow", async () => {
      queries["directorySubmissions:getDirectorySubmission"] = () => ({
        ...ROW,
        answers: [
          ...ROW.answers,
          { key: "listing.retired", value: "x", origin: "set", setAt: 1, revision: 1 },
        ],
      });
      const res = await request("GET", `${BASE}/${SUBMISSION}`);
      expect(res.status).toBe(200);
      const view = (await res.json()) as Record<string, any>;
      const codes = Object.fromEntries(
        view.fieldIssues.map((issue: any) => [issue.key, issue.code]),
      );
      expect(codes["listing.slug"]).toBe("required");
      expect(codes["listing.retired"]).toBe("unknownField");
      // Never ran: no run lookups at all.
      expect(convexQueryMock).toHaveBeenCalledTimes(1);
    });

    it("404s a submission from another project", async () => {
      queries["directorySubmissions:getDirectorySubmission"] = () => ({
        ...ROW,
        projectId: "p2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      });
      const res = await request("GET", `${BASE}/${SUBMISSION}`);
      expect(res.status).toBe(404);
    });

    it("lists summaries without answers, forwarding the filters", async () => {
      queries["directorySubmissions:listDirectorySubmissions"] = () => [ROW];
      const res = await request(
        "GET",
        `${BASE}?serverId=${SERVER}&flowId=claude-connector&limit=5`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<Record<string, unknown>> };
      expect(body.items[0]).toMatchObject({ id: SUBMISSION, revision: 3 });
      expect(body.items[0]).not.toHaveProperty("answers");
      const [, args] = convexQueryMock.mock.calls[0]!;
      expect(args).toEqual({
        projectId: PROJECT,
        serverId: SERVER,
        flowId: "claude-connector",
        limit: 5,
      });
    });

    it("refuses a limit outside 1 to 100", async () => {
      const res = await request("GET", `${BASE}?limit=500`);
      expect(res.status).toBe(400);
      expect(convexQueryMock).not.toHaveBeenCalled();
    });
  });

  describe("updating", () => {
    beforeEach(() => {
      mutations["directorySubmissions:updateDirectorySubmission"] = () => ({
        ...ROW,
        revision: 4,
      });
    });

    it("stamps the wording revision, the verified channel and the declared agent", async () => {
      const res = await request("PATCH", `${BASE}/${SUBMISSION}`, {
        body: {
          expectedRevision: 3,
          answers: { "listing.name": "Acme Search" },
          idempotencyKey: "w1",
        },
        headers: {
          "x-mcpjam-launcher": JSON.stringify({
            kind: "mcp",
            client: "claude-code",
            version: "2.1",
          }),
        },
      });
      expect(res.status).toBe(200);
      expect(mutationArgs("directorySubmissions:updateDirectorySubmission")).toEqual({
        submissionId: SUBMISSION,
        expectedRevision: 3,
        set: [
          {
            key: "listing.name",
            value: "Acme Search",
            origin: "set",
            wordingRevision: VERSION,
          },
        ],
        // A bearer the gateway could not verify reads as the API.
        setVia: "api",
        actorLabel: "claude-code 2.1",
        idempotencyKey: "w1",
      });
      expect(((await res.json()) as { revision: number }).revision).toBe(4);
    });

    it("refuses a value the field cannot hold, in the flow's words", async () => {
      const res = await request("PATCH", `${BASE}/${SUBMISSION}`, {
        body: { expectedRevision: 3, answers: { "useCases.access": "everything" } },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, any>;
      expect(body.message).toBe(
        "useCases.access: Choose one of: read-only, write-only, read-write.",
      );
      expect(body.details).toMatchObject({
        field: "useCases.access",
        step: "useCases",
        reason: "unknownOption",
      });
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it.each([
      ["an unknown field", { expectedRevision: 3, answers: { "listing.nope": "x" } }],
      ["confirming an unknown field", { expectedRevision: 3, confirm: ["listing.nope"] }],
      ["an unknown key", { expectedRevision: 3, actorLabel: "me" }],
      ["no expected revision", { answers: { "listing.name": "x" } }],
    ])("refuses %s before anything is written", async (_label, body) => {
      const res = await request("PATCH", `${BASE}/${SUBMISSION}`, { body });
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("removes with null, even a field the flow no longer has", async () => {
      await request("PATCH", `${BASE}/${SUBMISSION}`, {
        body: { expectedRevision: 3, answers: { "listing.retired": null } },
      });
      expect(
        mutationArgs("directorySubmissions:updateDirectorySubmission").unset,
      ).toEqual(["listing.retired"]);
    });

    it("confirms a stored answer, and stores a preselected one as confirmed", async () => {
      await request("PATCH", `${BASE}/${SUBMISSION}`, {
        body: {
          expectedRevision: 3,
          confirm: ["company.contactEmail", "useCases.access"],
        },
      });
      const args = mutationArgs("directorySubmissions:updateDirectorySubmission");
      expect(args.confirm).toEqual([
        { key: "company.contactEmail", wordingRevision: VERSION },
      ]);
      expect(args.set).toEqual([
        {
          key: "useCases.access",
          value: "read-only",
          origin: "confirmed",
          wordingRevision: VERSION,
        },
      ]);
    });

    it("sets and confirms one key in a single entry", async () => {
      await request("PATCH", `${BASE}/${SUBMISSION}`, {
        body: {
          expectedRevision: 3,
          answers: { "dataHandling.sponsored": "no" },
          confirm: ["dataHandling.sponsored"],
        },
      });
      const args = mutationArgs("directorySubmissions:updateDirectorySubmission");
      expect(args.set).toEqual([
        expect.objectContaining({ key: "dataHandling.sponsored", origin: "confirmed" }),
      ]);
      expect(args).not.toHaveProperty("confirm");
    });

    it("answers a conflict with the conflicting keys and the submission as it is now", async () => {
      mutations["directorySubmissions:updateDirectorySubmission"] = () => {
        throw new ConvexError({
          code: "CONFLICT",
          message:
            "This submission changed since you read it. Read it again and reapply your change.",
          currentRevision: 5,
          conflictingKeys: ["listing.oneLiner"],
        });
      };
      queries["directorySubmissions:getDirectorySubmission"] = () => ({
        ...ROW,
        revision: 5,
      });
      const res = await request("PATCH", `${BASE}/${SUBMISSION}`, {
        body: { expectedRevision: 1, answers: { "listing.oneLiner": "Mine" } },
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, any>;
      expect(body.code).toBe("CONFLICT");
      expect(body.details.currentRevision).toBe(5);
      expect(body.details.conflictingKeys).toEqual(["listing.oneLiner"]);
      expect(body.details.current).toMatchObject({ id: SUBMISSION, revision: 5 });
      expect(body.details.current.steps).toHaveLength(
        CLAUDE_CONNECTOR_FLOW.steps.length,
      );
    });

    it("marks a replayed write", async () => {
      mutations["directorySubmissions:updateDirectorySubmission"] = () => ({
        ...ROW,
        replayed: true,
      });
      const res = await request("PATCH", `${BASE}/${SUBMISSION}`, {
        body: { expectedRevision: 2, answers: { "listing.name": "x" }, idempotencyKey: "w1" },
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { replayed?: boolean }).replayed).toBe(true);
    });
  });

  describe("results", () => {
    const COMPLETE_RUN = {
      id: RUN,
      status: "completed",
      hasReport: true,
      submissionId: SUBMISSION,
      submissionRevision: 2,
      readinessKind: "claude",
      createdAt: 20,
      updatedAt: 30,
    };

    beforeEach(() => {
      queries["directorySubmissions:getDirectorySubmission"] = () => ({
        ...ROW,
        lastRunId: RUN,
      });
      queries["claudeReadinessRuns:listReadinessRuns"] = () => [
        { ...COMPLETE_RUN, id: "runnewerxxxxxxxxxxxxxxxxxxxxxxxx", status: "failed", hasReport: false },
        COMPLETE_RUN,
      ];
      // The answers the run froze when it was requested.
      queries["directoryReadinessRunInputs:getReadinessRunInputs"] = () => ({
        runId: RUN,
        submissionId: SUBMISSION,
        submissionRevision: 2,
        flowId: "claude-connector",
        flowVersion: VERSION,
        answers: [
          { key: "listing.oneLiner", value: "An older line", origin: "set", revision: 1, wordingRevision: VERSION },
          { key: "company.contactEmail", value: "review@example.com", origin: "account", revision: 1, wordingRevision: VERSION },
        ],
      });
    });

    it("places the latest complete run's findings, stale where a frozen answer changed", async () => {
      const fetchMock = stubReport({
        findings: [
          finding("claude.submission.listing-fields", "satisfied"),
          finding("claude.submission.urls", "violated"),
        ],
      });
      const res = await request("GET", `${BASE}/${SUBMISSION}/results`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, any>;
      expect(body.run).toMatchObject({ id: RUN, submissionId: SUBMISSION, submissionRevision: 2 });
      const listing = body.steps.find((step: any) => step.step === "listing");
      const byId = Object.fromEntries(
        listing.findings.map((placed: any) => [placed.finding.id, placed]),
      );
      expect(byId["claude.submission.listing-fields"]).toMatchObject({
        evidenceStatus: "stale",
        staleBecause: ["listing.oneLiner"],
      });
      expect(byId["claude.submission.urls"].evidenceStatus).toBe("established");
      expect(body.counts.blockers).toBe(1);
      expect(body.counts.notChecked).toBe(1);
      // Frozen inputs read under the caller's own bearer, for this run.
      const inputsCall = convexQueryMock.mock.calls.find(
        ([ref]) => nameOf(ref) === "directoryReadinessRunInputs:getReadinessRunInputs",
      );
      expect(inputsCall?.[1]).toEqual({ runId: RUN });

      // Read by RUN id over the service token, after the caller's own run read.
      const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, any];
      expect(String(url)).toContain(`/internal/v1/claude-readiness/runs/report?runId=${RUN}`);
      expect(init.headers["x-inspector-service-token"]).toBe("service-token");
    });

    it("marks nothing stale when the run's frozen answers are gone", async () => {
      queries["directoryReadinessRunInputs:getReadinessRunInputs"] = () => null;
      stubReport({ findings: [finding("claude.submission.listing-fields", "satisfied")] });
      const res = await request("GET", `${BASE}/${SUBMISSION}/results`);
      const body = (await res.json()) as Record<string, any>;
      const listing = body.steps.find((step: any) => step.step === "listing");
      expect(listing.findings[0].evidenceStatus).toBe("established");
    });

    it("puts the same results in the submission view", async () => {
      stubReport({ findings: [finding("claude.submission.urls", "violated")] });
      const res = await request("GET", `${BASE}/${SUBMISSION}`);
      const view = (await res.json()) as Record<string, any>;
      expect(view.resultsRunId).toBe(RUN);
      const listing = view.steps.find((step: any) => step.step === "listing");
      expect(listing.counts.blockers).toBe(1);
    });

    it("answers no run before one completes", async () => {
      queries["claudeReadinessRuns:listReadinessRuns"] = () => [
        { ...COMPLETE_RUN, status: "running", hasReport: false },
      ];
      const res = await request("GET", `${BASE}/${SUBMISSION}/results`);
      const body = (await res.json()) as Record<string, any>;
      expect(body.run).toBeNull();
      expect(body.steps.every((step: any) => step.findings.length === 0)).toBe(true);
    });

    it("reads a named run only if it graded this submission and completed", async () => {
      queries["claudeReadinessRuns:getReadinessRun"] = () => ({
        ...COMPLETE_RUN,
        submissionId: "subotherxxxxxxxxxxxxxxxxxxxxxxxx",
      });
      const other = await request("GET", `${BASE}/${SUBMISSION}/results?runId=${RUN}`);
      expect(other.status).toBe(404);

      queries["claudeReadinessRuns:getReadinessRun"] = () => ({
        ...COMPLETE_RUN,
        status: "running",
      });
      const running = await request("GET", `${BASE}/${SUBMISSION}/results?runId=${RUN}`);
      expect(running.status).toBe(409);
    });

    it("fails, never answers without findings, when the stored report cannot be read", async () => {
      stubReport({ error: "boom" }, 500);
      const res = await request("GET", `${BASE}/${SUBMISSION}/results`);
      // The v1 envelope answers every INTERNAL_ERROR with 500.
      expect(res.status).toBe(500);
      expect(((await res.json()) as { message: string }).message).toBe(
        "The readiness report could not be read from storage. Try again in a minute.",
      );
    });
  });

  describe("starting a run", () => {
    beforeEach(() => {
      mutations["claudeReadinessRuns:requestReadinessRun"] = () => ({
        runId: RUN,
        jobId: "job_1",
        reused: false,
      });
    });

    it("grades the submission's own server and forwards the submission", async () => {
      const res = await request("POST", `${BASE}/${SUBMISSION}/runs`, {
        body: { idempotencyKey: "r1" },
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({
        runId: RUN,
        serverId: SERVER,
        readinessKind: "claude",
        includeLlmObservations: false,
      });
      expect(authorizeServerMock).toHaveBeenCalledWith(
        expect.anything(),
        "tok",
        PROJECT,
        SERVER,
      );
      expect(mutationArgs("claudeReadinessRuns:requestReadinessRun")).toMatchObject({
        projectId: PROJECT,
        serverId: SERVER,
        serverUrl: "https://connector.example.com/mcp",
        readinessKind: "claude",
        submissionId: SUBMISSION,
        idempotencyKey: "r1",
      });
      expect(executeHostedReadinessRunMock.mock.calls[0]![0]).toMatchObject({
        lease: { runId: RUN, jobId: "job_1" },
        publisher: "claude",
        submissionId: SUBMISSION,
      });
    });

    it("forwards the test plan revision the start names, and only when named", async () => {
      await request("POST", `${BASE}/${SUBMISSION}/runs`, {
        body: { testPlanRevision: 2 },
      });
      await request("POST", `${BASE}/${SUBMISSION}/runs`, { body: {} });
      const zero = await request("POST", `${BASE}/${SUBMISSION}/runs`, {
        body: { testPlanRevision: 0 },
      });
      expect(zero.status).toBe(400);
      const starts = convexMutationMock.mock.calls
        .filter(([ref]) => nameOf(ref) === "claudeReadinessRuns:requestReadinessRun")
        .map(([, args]) => args as Record<string, unknown>);
      expect(starts).toHaveLength(2);
      expect(starts[0]).toMatchObject({ submissionId: SUBMISSION, testPlanRevision: 2 });
      expect(starts[1]).not.toHaveProperty("testPlanRevision");
    });

    it("answers a stale test plan revision with the current one", async () => {
      mutations["claudeReadinessRuns:requestReadinessRun"] = () => {
        throw new ConvexError({
          code: "CONFLICT",
          message:
            "The test plan changed since you read it. Read revision 3, then try again.",
          currentRevision: 3,
        });
      };
      const res = await request("POST", `${BASE}/${SUBMISSION}/runs`, {
        body: { testPlanRevision: 2 },
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, any>;
      expect(body.details.currentRevision).toBe(3);
      expect(executeHostedReadinessRunMock).not.toHaveBeenCalled();
    });

    it("refuses a run the backend says does not match the submission", async () => {
      mutations["claudeReadinessRuns:requestReadinessRun"] = () => {
        throw new ConvexError({
          code: "submission_mismatch",
          message:
            "This submission is for a different server. Start the run against the submission's server.",
        });
      };
      const res = await request("POST", `${BASE}/${SUBMISSION}/runs`, { body: {} });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, any>;
      expect(body.message).toContain("different server");
      expect(executeHostedReadinessRunMock).not.toHaveBeenCalled();
    });

    it("refuses a body that names its own server", async () => {
      const res = await request("POST", `${BASE}/${SUBMISSION}/runs`, {
        body: { serverId: "srvotherxxxxxxxxxxxxxxxxxxxxxxxx" },
      });
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
      expect(authorizeServerMock).not.toHaveBeenCalled();
    });
  });

  it("deletes a submission and says so", async () => {
    mutations["directorySubmissions:deleteDirectorySubmission"] = () => ({
      deleted: true,
    });
    const res = await request("DELETE", `${BASE}/${SUBMISSION}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: SUBMISSION, deleted: true });
  });
});
