/**
 * What a reader resumes a directory submission from: the handoff summary, the
 * findings page by page, the export pack, the recorded events and the
 * labelled snapshots.
 *
 * Convex is mocked at the `convex/browser` boundary and the report and diff
 * reads at `fetch`, as in the submission route tests, so these prove the
 * GATEWAY: what it reads, what it forwards, and what it never lets out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { CLAUDE_CONNECTOR_FLOW, renderDirectoryExportMarkdown } from "@mcpjam/sdk";

const { validateGuestTokenMock, convexQueryMock, convexMutationMock } = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  convexQueryMock: vi.fn(),
  convexMutationMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(function () {
    return { setAuth: vi.fn(), query: convexQueryMock, mutation: convexMutationMock };
  }),
}));

import v1Routes from "../index.js";

const PROJECT = "p1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SUBMISSION = "subxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SERVER = "srvxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const RUN = "runxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const ONE = `/api/v1/projects/${PROJECT}/directory-submissions/${SUBMISSION}`;
const VERSION = CLAUDE_CONNECTOR_FLOW.version;
/** The value of a project secret, and a token: neither may leave through any read here. */
const SECRET = "sample-reviewer-password-7f3c";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.c2FtcGxlLXRva2Vu.c2lnbmF0dXJl";

const ROW = {
  id: SUBMISSION,
  projectId: PROJECT,
  serverId: SERVER,
  directory: "claude",
  flowId: "claude-connector",
  flowVersion: VERSION,
  answers: [
    { key: "listing.oneLiner", value: "Search Acme's docs", origin: "set", setBy: "user_1", setVia: "web", setAt: 10, revision: 2, wordingRevision: VERSION },
  ],
  revision: 3,
  createdBy: "user_1",
  lastRunId: RUN,
  createdAt: 5,
  updatedAt: 10,
  // A field no reader asked for: the export must not carry it.
  reviewerPassword: SECRET,
};
const RUN_ROW = { id: RUN, status: "completed", hasReport: true, submissionId: SUBMISSION, createdAt: 20, updatedAt: 30 };

/** A stored result, as the results store returns one. */
function stored(checkId: string, lane: string, status = "violated") {
  return {
    runId: RUN,
    checkId,
    lane,
    class: "required",
    status,
    title: `Check ${checkId}`,
    evaluatedAt: 30,
    engineVersion: "test",
    updatedAt: 31,
    hasDetails: false,
  };
}

/** 130 results, alternating between a lane placed on Listing and one placed on Tools. */
const STORE = Array.from({ length: 130 }, (_, index) =>
  stored(`claude.sample-${String(index).padStart(3, "0")}`, index % 2 ? "directory-policy" : "submission-artifacts")
);

type Handler = (args: Record<string, any>) => unknown;
let queries: Record<string, Handler>;
let mutations: Record<string, Handler>;
let report: { findings: unknown[] };

const nameOf = (ref: unknown) => (typeof ref === "string" ? ref : getFunctionName(ref as never));

/** The results store's paging: `limit` rows from an index cursor. */
function page(rows: Array<ReturnType<typeof stored>>): Handler {
  return (args) => {
    const matching = rows.filter((row) => (!args.status || row.status === args.status) && (!args.lane || row.lane === args.lane));
    const start = Number(args.cursor ?? 0);
    const end = Math.min(start + args.limit, matching.length);
    return { page: matching.slice(start, end), isDone: end >= matching.length, continueCursor: String(end) };
  };
}

function request(method: string, path: string, opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.token ?? "tok"}`, ...opts.headers },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

async function json(response: Response | Promise<Response>) {
  return (await (await response).json()) as Record<string, any>;
}

function callsTo(name: string) {
  return convexQueryMock.mock.calls.filter(([ref]) => nameOf(ref) === name).map(([, args]) => args);
}

describe("v1 directory submission handoff", () => {
  const env = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    report = {
      findings: STORE.map((row) => ({
        id: row.checkId,
        title: row.title,
        lane: row.lane,
        class: row.class,
        status: row.status,
        source: {},
        provenance: "wire",
        intrusiveness: "passive",
        evaluatedAt: "2026-11-13T00:00:00.000Z",
        engineVersion: "test",
        details: { authorization: `Bearer ${TOKEN}`, password: SECRET },
      })),
    };
    queries = {
      "directorySubmissions:getDirectorySubmission": () => ROW,
      "claudeReadinessRuns:listReadinessRuns": () => [RUN_ROW],
      "claudeReadinessRuns:getReadinessRun": () => RUN_ROW,
      "directoryReadinessRunInputs:getReadinessRunInputs": () => null,
      "directorySubmissionEvents:listDirectorySubmissionEvents": ({ kind }) =>
        kind === "status"
          ? [{ id: "e1", submissionId: SUBMISSION, projectId: PROJECT, kind, state: "submitted", reportedOrObserved: "reported", actor: "user_1", createdAt: 40, value: SECRET }]
          : [],
      "directorySubmissionEvents:getDirectorySubmissionSnapshots": () => ({
        submissionId: SUBMISSION,
        snapshots: { candidate: null, production: null, directory: null, published: null },
      }),
      "directorySubmissionResults:listDirectorySubmissionResults": page(STORE),
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = new URL(String(input));
        if (url.pathname === "/internal/v1/claude-readiness/runs/report") return Response.json(report);
        if (url.pathname === "/v1/project-server-revision-diff") {
          return Response.json({ from: { revisionNumber: Number(url.searchParams.get("from")) }, tools: { added: [], removed: [], changed: [] } });
        }
        throw new Error(`unexpected fetch ${url}`);
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...env };
  });

  it.each([
    ["GET", "/handoff"],
    ["GET", "/findings"],
    ["GET", "/findings/claude.endpoint.https"],
    ["GET", "/export"],
    ["GET", "/events"],
    ["POST", "/events"],
    ["GET", "/snapshots"],
  ])("denies a guest %s %s", async (method, path) => {
    validateGuestTokenMock.mockResolvedValue({ valid: true, guestId: "guest_1" });
    const res = await request(method, `${ONE}${path}`, { token: "guest-jwt", ...(method === "POST" ? { body: {} } : {}) });
    expect(res.status).toBe(401);
    expect(convexQueryMock).not.toHaveBeenCalled();
  });

  it("404s a submission from another project, on every read", async () => {
    queries["directorySubmissions:getDirectorySubmission"] = () => ({ ...ROW, projectId: "p2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
    for (const path of ["/handoff", "/findings", "/export", "/events", "/snapshots"]) {
      expect((await request("GET", `${ONE}${path}`)).status).toBe(404);
    }
  });

  describe("handoff", () => {
    it("builds the summary from the record, reading each event kind and the newest run", async () => {
      const handoff = await json(request("GET", `${ONE}/handoff`));
      expect(handoff.status).toMatchObject({ state: "submitted", reportedOrObserved: "reported" });
      expect(handoff.counts.findings).toBe(130);
      expect(handoff.blockers).toHaveLength(10);
      expect(handoff.run).toEqual({ resultsRunId: RUN, latest: { id: RUN, status: "completed", resumable: false } });
      expect(callsTo("directorySubmissionEvents:listDirectorySubmissionEvents")).toEqual([
        { submissionId: SUBMISSION, kind: "status", limit: 100 },
        { submissionId: SUBMISSION, kind: "credential", limit: 100 },
        { submissionId: SUBMISSION, kind: "directory-finding", limit: 100 },
      ]);
      expect(callsTo("claudeReadinessRuns:getReadinessRun")).toEqual([{ runId: RUN }]);
      expect(JSON.stringify(handoff)).not.toContain(SECRET);
    });
  });

  describe("findings", () => {
    async function all(query: string) {
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const body = await json(request("GET", `${ONE}/findings?${query}${cursor ? `&cursor=${cursor}` : ""}`));
        ids.push(...body.items.map((item: { checkId: string }) => item.checkId));
        cursor = body.nextCursor;
      } while (cursor);
      return ids;
    }

    it("pages every finding past 50, in the store's order", async () => {
      expect(await all("limit=50")).toEqual(STORE.map((row) => row.checkId));
      // Always whole backend pages, resumed from the cursor: never a skipped row.
      for (const args of callsTo("directorySubmissionResults:listDirectorySubmissionResults")) expect(args.limit).toBe(100);
    });

    it("filters by the flow's step, agreeing with the summary's counts", async () => {
      const listing = await all("step=listing&limit=40");
      const handoff = await json(request("GET", `${ONE}/handoff`));
      const counted = handoff.counts.steps.find((entry: { step: string }) => entry.step === "listing").findings;
      expect(listing).toHaveLength(65);
      expect(listing).toHaveLength(counted);
      expect(new Set(listing)).toEqual(new Set(STORE.filter((row) => row.lane === "submission-artifacts").map((row) => row.checkId)));
      const [first] = (await json(request("GET", `${ONE}/findings?step=listing&limit=1`))).items;
      expect(first).toMatchObject({ checkId: "claude.sample-000", step: "listing", status: "violated" });
    });

    it("forwards status and lane, and refuses a filter the flow does not have", async () => {
      await request("GET", `${ONE}/findings?status=violated&lane=directory-policy`);
      expect(callsTo("directorySubmissionResults:listDirectorySubmissionResults")[0]).toEqual({
        submissionId: SUBMISSION,
        status: "violated",
        lane: "directory-policy",
        limit: 100,
      });
      for (const query of ["status=nope", "step=nope", "lane=plugin-package", "limit=500", "cursor=not-a-cursor"]) {
        expect((await request("GET", `${ONE}/findings?${query}`)).status, query).toBe(400);
      }
    });

    it("reads one finding with its details, and 404s a check with no result", async () => {
      queries["directorySubmissionResults:getDirectorySubmissionResult"] = ({ checkId }) =>
        checkId === "claude.endpoint.https"
          ? { ...stored(checkId, "runtime-compatibility"), hasDetails: true, details: JSON.stringify({ status: 301 }) }
          : null;
      const one = await json(request("GET", `${ONE}/findings/claude.endpoint.https`));
      expect(one).toMatchObject({ checkId: "claude.endpoint.https", step: "connection", field: "connection.serverUrl", details: { status: 301 } });
      expect((await request("GET", `${ONE}/findings/claude.nothing`)).status).toBe(404);
    });
  });

  describe("export", () => {
    it("serves one pack as JSON and as Markdown rendered from that JSON", async () => {
      const asJson = await json(request("GET", `${ONE}/export`));
      const asMarkdown = await json(request("GET", `${ONE}/export?format=markdown`));
      expect(asJson).toMatchObject({ format: "json", mediaType: "application/json", filename: `claude-connector-${SUBMISSION}-r3.json` });
      expect(asMarkdown).toMatchObject({ format: "markdown", mediaType: "text/markdown", filename: `claude-connector-${SUBMISSION}-r3.md` });
      const pack = JSON.parse(asJson.content);
      expect(pack.kind).toBe("mcpjam.directory-submission-export");
      expect(asMarkdown.content).toBe(renderDirectoryExportMarkdown(pack));
      // The same record exports the same bytes.
      expect((await json(request("GET", `${ONE}/export`))).content).toBe(asJson.content);
    });

    it("holds no secret: not a finding's details, a row's extra field or an event's", async () => {
      for (const format of ["json", "markdown"]) {
        const { content } = await json(request("GET", `${ONE}/export?format=${format}`));
        expect(content).not.toContain(SECRET);
        expect(content).not.toContain(TOKEN);
      }
    });

    it("refuses a format it does not have", async () => {
      expect((await request("GET", `${ONE}/export?format=pdf`)).status).toBe(400);
    });
  });

  describe("events", () => {
    const RECORD = "directorySubmissionEvents:recordDirectorySubmissionEvent";

    it("lists events, forwarding the kind and limit", async () => {
      const body = await json(request("GET", `${ONE}/events?kind=status&limit=5`));
      expect(body.items).toHaveLength(1);
      expect(callsTo("directorySubmissionEvents:listDirectorySubmissionEvents")).toEqual([
        { submissionId: SUBMISSION, kind: "status", limit: 5 },
      ]);
    });

    it("records a snapshot of the submission's own server, labelled from the verified attribution", async () => {
      mutations[RECORD] = (args) => ({ id: "e2", ...args, actor: "user_1", createdAt: 50 });
      const res = await request("POST", `${ONE}/events`, {
        body: { kind: "snapshot", reportedOrObserved: "observed", snapshot: { label: "production", revisionNumber: 12 } },
        headers: { "x-mcpjam-launcher": JSON.stringify({ kind: "mcp", client: "claude-code", version: "2.1" }) },
      });
      expect(res.status).toBe(201);
      expect(convexMutationMock.mock.calls[0]![1]).toEqual({
        kind: "snapshot",
        reportedOrObserved: "observed",
        submissionId: SUBMISSION,
        snapshot: { label: "production", revisionNumber: 12, serverId: SERVER },
        actorLabel: "claude-code 2.1",
      });
    });

    it("answers a replayed record with 200, and the backend's refusal with 400", async () => {
      mutations[RECORD] = () => ({ id: "e1", replayed: true });
      const body = { kind: "status", reportedOrObserved: "reported", state: "submitted", idempotencyKey: "k1" };
      expect((await request("POST", `${ONE}/events`, { body })).status).toBe(200);
      mutations[RECORD] = () => {
        throw new ConvexError({ code: "VALIDATION", message: "A status event needs one of these states: submitted, in-review." });
      };
      const refused = await request("POST", `${ONE}/events`, { body: { ...body, state: "done" } });
      expect(refused.status).toBe(400);
      expect((await json(refused)).message).toContain("needs one of these states");
    });

    it.each([
      ["a Bearer credential", { detail: "Reviewer header: Authorization: Bearer Abc123xyz789" }],
      ["a JWT in a directory's text", { kind: "directory-finding", finding: { text: `token ${TOKEN}`, via: "email" } }],
      ["a URL with a password", { link: "https://reviewer:hunter2@portal.example.com" }],
      ["a secret's value as its own field", { value: SECRET }],
    ])("refuses %s before anything is written", async (_label, extra) => {
      const res = await request("POST", `${ONE}/events`, {
        body: { kind: "credential", reportedOrObserved: "reported", state: "saved", ...extra },
      });
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("keeps prose that only mentions a scheme", async () => {
      mutations[RECORD] = (args) => ({ id: "e3", ...args });
      const body = { kind: "directory-finding", reportedOrObserved: "reported", finding: { text: "Bearer token required; Basic authentication is refused.", via: "portal" } };
      expect((await request("POST", `${ONE}/events`, { body })).status).toBe(201);
    });
  });

  describe("snapshots", () => {
    const snap = (label: string, revisionNumber: number) => ({
      id: `e-${label}`,
      kind: "snapshot",
      snapshot: { label, serverId: SERVER, revisionNumber },
      revision: { revisionNumber, capturedAt: 1, counts: { tools: 64 }, contractHash: `hash-${revisionNumber}` },
    });

    it("returns the latest per label, and compares two labels' revisions on request", async () => {
      queries["directorySubmissionEvents:getDirectorySubmissionSnapshots"] = () => ({
        submissionId: SUBMISSION,
        snapshots: { candidate: null, production: snap("production", 12), directory: snap("directory", 10), published: null },
      });
      const plain = await json(request("GET", `${ONE}/snapshots`));
      expect(plain.snapshots.production.revision.revisionNumber).toBe(12);
      expect(plain).not.toHaveProperty("comparison");
      const compared = await json(request("GET", `${ONE}/snapshots?compare=production,directory`));
      expect(compared.comparison).toMatchObject({ from: "production", to: "directory", diff: { from: { revisionNumber: 12 } } });
      const [url] = vi.mocked(fetch).mock.calls.at(-1)! as [string];
      expect(Object.fromEntries(new URL(String(url)).searchParams)).toEqual({
        projectId: PROJECT,
        serverId: SERVER,
        revisionNumber: "10",
        from: "12",
      });
    });

    it("refuses a comparison of a bad label or a snapshot with no revision", async () => {
      expect((await request("GET", `${ONE}/snapshots?compare=production`)).status).toBe(400);
      expect((await request("GET", `${ONE}/snapshots?compare=production,live`)).status).toBe(400);
      expect((await request("GET", `${ONE}/snapshots?compare=production,directory`)).status).toBe(409);
    });
  });
});
