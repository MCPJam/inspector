/**
 * A submission run's reviewer path, end to end through the worker: the
 * identity check and the fixture lookup run on the reviewer account the start
 * authorized and on no other, discovery is requested again under other client
 * signatures, and a run without a reviewer account blocks every reviewer
 * check with the reason, calling nothing as the requester (RP2).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const claimReadinessRun = vi.fn();
const heartbeatReadinessRun = vi.fn();
const finalizeReadinessRun = vi.fn();
const failReadinessRun = vi.fn();
const getReadinessRunSubmission = vi.fn();

const { ReadinessLeaseLostError } = await import("../runner.js");
const { ReadinessSubmissionUnreadableError } = await vi.importActual<
  typeof import("../backend-client.js")
>("../backend-client.js");

vi.mock("../backend-client.js", () => ({
  claimReadinessRun: (...args: unknown[]) => claimReadinessRun(...args),
  heartbeatReadinessRun: (...args: unknown[]) => heartbeatReadinessRun(...args),
  finalizeReadinessRun: (...args: unknown[]) => finalizeReadinessRun(...args),
  failReadinessRun: (...args: unknown[]) => failReadinessRun(...args),
  getReadinessRunSubmission: (...args: unknown[]) =>
    getReadinessRunSubmission(...args),
  requestManagedObservations: vi.fn(),
  joinReviewerAttempt: vi.fn(),
  ReadinessLeaseLostError,
  ReadinessSubmissionUnreadableError,
}));

const { executeHostedReadinessRun } = await import("../worker.js");

const LEASE = { runId: "run_1", jobId: "job_1" };
const TARGET = "https://connector.example.com/mcp";
const PRM =
  "https://connector.example.com/.well-known/oauth-protected-resource/mcp";
const AS_METADATA =
  "https://auth.example.com/.well-known/oauth-authorization-server";
const STAFF = "Bearer staff-token";
const REVIEWER = "Bearer reviewer-token";
const NO_ACCOUNT =
  "No reviewer account is connected for this submission. Rehearse the reviewer sign-in, then run again.";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false };
const TOOLS = [
  {
    name: "whoami",
    inputSchema: { type: "object", properties: {} },
    annotations: READ_ONLY,
  },
  {
    name: "list_projects",
    inputSchema: { type: "object", properties: {} },
    annotations: READ_ONLY,
  },
];
const WHO = {
  [STAFF]: {
    user: { email: "staff@example.com" },
    organization: { name: "Staff Org" },
  },
  [REVIEWER]: {
    user: { email: "review@example.com" },
    organization: { name: "Sample Org" },
  },
};

const answer = (key: string, value: unknown) => ({ key, value, origin: "set" });
const SUBMISSION = {
  submissionId: "sub_1",
  submissionRevision: 3,
  flowId: "claude-connector",
  flowVersion: "2026-11-13",
  answers: [
    answer(
      "testLaunch.instructions",
      "Open Sample Project and list its servers.",
    ),
    answer("testLaunch.identityTool", "whoami"),
    answer("testLaunch.expectedIdentityPath", "$.user.email"),
    answer("testLaunch.expectedIdentity", "review@example.com"),
    answer("testLaunch.expectedOrganizationPath", "$.organization.name"),
    answer("testLaunch.expectedOrganization", "Sample Org"),
    answer("testLaunch.fixtures", [
      { fixture: "Sample Project", lookup: "list_projects" },
    ]),
  ],
};

interface Seen {
  method: string;
  url: string;
  rpc?: string;
  tool?: string;
  authorization: string | null;
  userAgent: string | null;
}

/** The connector: refuses one client signature at discovery, answers each account as itself. */
function connector() {
  const seen: Seen[] = [];
  const json = (
    body: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const method = String(init?.method ?? "GET").toUpperCase();
    const body =
      method === "POST" ? JSON.parse(String(init?.body ?? "{}")) : undefined;
    const authorization = headers.get("authorization");
    seen.push({
      method,
      url: String(url),
      rpc: body?.method,
      tool: body?.params?.name,
      authorization,
      userAgent: headers.get("user-agent"),
    });
    if (method === "HEAD") return new Response(null, { status: 200 });
    if (method === "GET") {
      if (headers.get("user-agent")?.startsWith("Python-urllib")) {
        return new Response("error code: 1010", { status: 403 });
      }
      if (String(url) === PRM) {
        return json({
          resource: TARGET,
          authorization_servers: ["https://auth.example.com"],
        });
      }
      if (String(url) === AS_METADATA) {
        return json({
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          code_challenge_methods_supported: ["S256"],
          response_types_supported: ["code"],
        });
      }
      return new Response("", { status: 404 });
    }
    if (!authorization) {
      return json(
        {
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32001, message: "sign in" },
        },
        401,
        {
          "www-authenticate": `Bearer resource_metadata="${PRM}"`,
        },
      );
    }
    const results: Record<string, unknown> = {
      initialize: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
      },
      "tools/list": { tools: TOOLS },
      "resources/list": { resources: [] },
      "tools/call":
        body.params?.name === "whoami"
          ? {
              structuredContent: WHO[authorization as keyof typeof WHO],
              content: [],
            }
          : {
              structuredContent: { projects: [{ name: "Sample Project" }] },
              content: [],
            },
    };
    return json({
      jsonrpc: "2.0",
      id: body.id,
      result: results[body.method] ?? {},
    });
  }) as unknown as typeof fetch;
  return { seen, fetchFn };
}

function reportFindings() {
  const report = finalizeReadinessRun.mock.calls[0]![2] as {
    findings: Array<{
      id: string;
      status: string;
      notEvaluatedReason?: string;
      details?: Record<string, unknown>;
    }>;
  };
  return (id: string) => report.findings.find((finding) => finding.id === id);
}

beforeEach(() => {
  vi.clearAllMocks();
  claimReadinessRun.mockResolvedValue({ status: "claimed" });
  heartbeatReadinessRun.mockResolvedValue({ alive: true });
  finalizeReadinessRun.mockResolvedValue({ applied: true });
  failReadinessRun.mockResolvedValue({ applied: true });
  getReadinessRunSubmission.mockResolvedValue(SUBMISSION);
});

function run(
  fetchFn: typeof fetch,
  extra: Partial<Parameters<typeof executeHostedReadinessRun>[0]> = {},
) {
  return executeHostedReadinessRun({
    lease: LEASE,
    publisher: "claude",
    target: TARGET,
    fetchFn,
    mcpHeaders: { authorization: STAFF },
    includeLlmObservations: false,
    submissionId: "sub_1",
    ...extra,
  });
}

describe("a submission run with a reviewer account", () => {
  it("checks who the reviewer is and the fixtures, as the reviewer only", async () => {
    const server = connector();
    await run(server.fetchFn, {
      reviewer: {
        accountId: "acct_reviewer",
        mcpHeaders: { authorization: REVIEWER },
      },
    });
    expect(failReadinessRun).not.toHaveBeenCalled();
    const finding = reportFindings();
    expect(finding("both.reviewer.identity")).toMatchObject({
      status: "satisfied",
      details: {
        call: { tool: "whoami", arguments: {} },
        observed: {
          identity: "review@example.com",
          organization: "Sample Org",
        },
      },
    });
    expect(finding("both.reviewer.fixtures")?.status).toBe("satisfied");

    const calls = server.seen.filter((entry) => entry.rpc === "tools/call");
    expect(calls.map((entry) => entry.tool)).toEqual([
      "whoami",
      "list_projects",
    ]);
    expect(calls.every((entry) => entry.authorization === REVIEWER)).toBe(true);
  });

  it("reports a refused client signature with its status and body (RP9)", async () => {
    const server = connector();
    await run(server.fetchFn, {
      reviewer: {
        accountId: "acct_reviewer",
        mcpHeaders: { authorization: REVIEWER },
      },
    });
    const probes = server.seen.filter(
      (entry) => entry.method === "GET" && entry.userAgent,
    );
    expect(probes.map((entry) => entry.url)).toEqual([
      PRM,
      PRM,
      AS_METADATA,
      AS_METADATA,
    ]);
    expect(probes.every((entry) => entry.authorization === null)).toBe(true);
    expect(reportFindings()("both.auth.client-signatures")).toMatchObject({
      status: "violated",
      details: {
        probes: expect.arrayContaining([
          expect.objectContaining({
            signature: "http-library",
            status: 403,
            body: "error code: 1010",
          }),
        ]),
      },
    });
  });
});

describe("a submission run without a reviewer account", () => {
  it.each([
    ["the start's reason", { reviewer: { missing: NO_ACCOUNT } }, NO_ACCOUNT],
    [
      "no account at all",
      {},
      "This run was started without the reviewer account. Start a new run from the submission.",
    ],
  ])(
    "blocks every reviewer check with %s, and calls nothing as the requester",
    async (_case, extra, reason) => {
      const server = connector();
      await run(server.fetchFn, extra);
      const finding = reportFindings();
      for (const id of [
        "both.reviewer.identity",
        "both.reviewer.fixtures",
        "claude.intrusive.refresh-rotation",
      ]) {
        expect(finding(id), id).toMatchObject({
          status: "not-evaluated",
          notEvaluatedReason: `blocked: ${reason}`,
        });
      }
      expect(server.seen.some((entry) => entry.rpc === "tools/call")).toBe(
        false,
      );
      expect(
        server.seen.some((entry) => entry.authorization === REVIEWER),
      ).toBe(false);
    },
  );
});

describe("a run that grades no submission", () => {
  it("has no reviewer path and sends no other client signature", async () => {
    const server = connector();
    await executeHostedReadinessRun({
      lease: LEASE,
      publisher: "claude",
      target: TARGET,
      fetchFn: server.fetchFn,
      mcpHeaders: { authorization: STAFF },
      includeLlmObservations: false,
    });
    expect(reportFindings()("both.reviewer.identity")?.status).toBe(
      "not-applicable",
    );
    expect(server.seen.some((entry) => entry.userAgent)).toBe(false);
  });
});
