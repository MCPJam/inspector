/**
 * A failed server dependency takes only what needs the server with it.
 *
 * Gathered for real, against transports that refuse, then graded and placed
 * the way the Readiness page places them: the checks graded from answers keep
 * their verdicts, every check whose placement needs the server says why it
 * has none, and nothing that needs the server is reported as passed, failed
 * or merely not tested.
 */

import { describe, expect, it } from "vitest";

import {
  runClaudeAuthChecks,
  type ClaudeAuthEvidence,
} from "../../src/claude-readiness/checks/auth.js";
import { gatherClaudeReadinessEvidence } from "../../src/claude-readiness/gather.js";
import type { ClaudeExperienceObservations } from "../../src/claude-readiness/observations.js";
import {
  gradeClaudeReadiness,
  type ClaudeReadinessInput,
} from "../../src/claude-readiness/runner.js";
import {
  CLAUDE_CONNECTOR_FLOW as FLOW,
  placeDirectoryResults,
  type DirectoryReadinessFinding,
  type PlacedFinding,
} from "../../src/directory-readiness/index.js";
import { completeAnswers } from "../support/claude-connector-answers.js";

const TARGET = "https://connector.example.com/mcp";
const PRM_URL =
  "https://connector.example.com/.well-known/oauth-protected-resource/mcp";
const now = () => new Date("2026-08-20T00:00:00.000Z");
const STAMP = { evaluatedAt: "2026-08-20T00:00:00.000Z" };

/** Checks whose placement says they need the server. */
const NEEDS_SERVER = new Set(
  FLOW.placements
    .filter((placement) => placement.needs?.includes("server"))
    .map((placement) => placement.checkId)
);

/** What Node's fetch throws when nothing listens. */
const refusing: typeof fetch = async () => {
  throw new TypeError("fetch failed");
};

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Discovery answers; every MCP request is refused with a 401. */
const refusingSessions: typeof fetch = async (input, init) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "HEAD") return new Response(null, { status: 200 });
  if (method === "POST") {
    return json(
      {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32001, message: "Unauthorized" },
      },
      401,
      { "www-authenticate": `Bearer resource_metadata="${PRM_URL}"` }
    );
  }
  if (url === PRM_URL) {
    return json({
      resource: TARGET,
      authorization_servers: ["https://auth.example.com"],
    });
  }
  if (url.startsWith("https://auth.example.com/.well-known/")) {
    return json({
      issuer: "https://auth.example.com",
      registration_endpoint: "https://auth.example.com/register",
      code_challenge_methods_supported: ["S256"],
      response_types_supported: ["code"],
    });
  }
  return new Response("", { status: 404 });
};

async function gather(
  fetchFn: typeof fetch,
  extra: Partial<Parameters<typeof gatherClaudeReadinessEvidence>[0]> = {}
): Promise<ClaudeReadinessInput> {
  const evidence = await gatherClaudeReadinessEvidence({
    enteredUrl: TARGET,
    fetchFn,
    now,
    ...extra,
  });
  return { ...evidence, submissionAnswers: completeAnswers() };
}

function place(findings: readonly DirectoryReadinessFinding[]) {
  return new Map(
    placeDirectoryResults({ flow: FLOW, answers: completeAnswers(), findings })
      .flatMap((step) => step.findings)
      .map((entry): [string, PlacedFinding] => [entry.finding.id, entry])
  );
}

const ANSWER_GRADED = [
  "claude.endpoint.https",
  "claude.submission.listing-fields",
  "claude.submission.urls",
  "claude.submission.attestations",
];

describe("a server nothing answers", () => {
  it("is recorded on the evidence with the transport's reason", async () => {
    const evidence = await gather(refusing);
    expect(evidence.serverFailure).toEqual({
      kind: "unreachable",
      detail: "fetch failed",
    });
    expect(evidence.auth.prm).toMatchObject({
      discoveredVia: "not-found",
      unanswered: true,
    });
    expect(JSON.parse(JSON.stringify(evidence))).toEqual(evidence);
  });

  it("leaves the answer-graded verdicts standing", async () => {
    const result = gradeClaudeReadiness(await gather(refusing));
    for (const id of ANSWER_GRADED) {
      expect(result.findings.find((f) => f.id === id)?.status, id).toBe(
        "satisfied"
      );
    }
  });

  it("blocks every check that needs the server, naming the failure", async () => {
    const result = gradeClaudeReadiness(await gather(refusing));
    const needing = result.findings.filter((f) => NEEDS_SERVER.has(f.id));
    expect(needing.length).toBeGreaterThan(30);
    for (const finding of needing) {
      if (finding.status === "not-applicable") continue;
      expect(finding.status, finding.id).toBe("not-evaluated");
      expect(finding.notEvaluatedReason, finding.id).toBe(
        "blocked: the server could not be reached: fetch failed"
      );
    }
  });

  it("does not grade the missing metadata as the server's defect", async () => {
    // A refused request is not a server that publishes no metadata: before
    // this was fixed, the run came back `not-ready` for an outage.
    const result = gradeClaudeReadiness(await gather(refusing));
    expect(
      result.findings.find((f) => f.id === "claude.auth.prm-discoverable")
        ?.status
    ).toBe("not-evaluated");
    expect(result.status).toBe("incomplete");
    expect(result.summary).toBe(
      "Readiness is undetermined: the server could not be reached (fetch failed). Results that need no server stand. Check that the server is up and reachable, then run again."
    );
  });

  it("places the server checks as blocked and the rest as established", async () => {
    const placed = place(gradeClaudeReadiness(await gather(refusing)).findings);
    for (const [id, entry] of placed) {
      if (entry.finding.status === "not-applicable") continue;
      expect(entry.evidenceStatus, id).toBe(
        NEEDS_SERVER.has(id) ? "blocked" : "established"
      );
    }
  });

  it("publishes no model observation about a server it never read", async () => {
    const envelope: ClaudeExperienceObservations = {
      readinessKind: "claude-directory-readiness",
      observationKind: "experience",
      observationSchemaVersion: "1",
      modelId: "sample-model",
      promptVersion: "1",
      observedAt: "2026-08-20T00:00:00.000Z",
      observations: [
        {
          id: "claude.experience.connector-purpose-unclear",
          confidence: "high",
          summary: "No tools are advertised.",
          evidenceRefs: [],
        },
      ],
    };
    const input = await gather(refusing);
    const result = gradeClaudeReadiness({
      ...input,
      llmObservations: { status: "completed", envelope },
    });
    // The decision checks are there, each saying why no model judged it.
    expect(
      result.findings.some(
        (f) => f.provenance === "llm" && f.status !== "not-evaluated"
      )
    ).toBe(false);
  });

  it("keeps verdicts over a tool listing the caller already held", async () => {
    const result = gradeClaudeReadiness(
      await gather(refusing, {
        tools: [
          {
            name: "list_orders",
            description: "List recent orders.",
            annotations: { title: "List orders", readOnlyHint: true },
            inputSchema: { type: "object", properties: {} },
          },
        ],
        apps: { enteredUrl: TARGET, appsSuiteRan: true, tools: [] },
      })
    );
    const byId = (id: string) => result.findings.find((f) => f.id === id);
    expect(byId("claude.tools.title-present")?.status).toBe("satisfied");
    expect(byId("claude.submission.access-matches-annotations")?.status).toBe(
      "satisfied"
    );
    expect(
      byId("claude.auth.unauthenticated-challenge")?.notEvaluatedReason
    ).toBe("blocked: the server could not be reached: fetch failed");
  });
});

describe("metadata discovery nobody answered", () => {
  const prmStatus = (prm: ClaudeAuthEvidence["prm"]) =>
    runClaudeAuthChecks({ enteredUrl: TARGET, prm }, STAMP).findings.find(
      (finding) => finding.id === "claude.auth.prm-discoverable"
    );

  it("is not graded as a server that publishes none", () => {
    expect(
      prmStatus({
        discoveredVia: "not-found",
        fetchError: "fetch failed",
        unanswered: true,
      })
    ).toMatchObject({
      status: "not-evaluated",
      notEvaluatedReason:
        "no request for Protected Resource Metadata was answered (fetch failed)",
    });
    // A pointer to another origin is a defect whatever answered.
    expect(
      prmStatus({
        discoveredVia: "not-found",
        fetchError: "fetch failed",
        unanswered: true,
        rejectedPointer: "https://elsewhere.example.com/prm",
      })
    ).toMatchObject({
      status: "violated",
      details: { rejectedPointer: "https://elsewhere.example.com/prm" },
    });
    // Answered with 404s, the same result is still the server's defect.
    expect(
      prmStatus({ discoveredVia: "not-found", fetchError: "answered 404" })
        ?.status
    ).toBe("violated");
  });
});

describe("a server that refuses the connection", () => {
  it("blocks what the session would have listed, and only that", async () => {
    const input = await gather(refusingSessions, {
      mcpHeaders: { authorization: "Bearer expired-sample-token" },
    });
    expect(input.serverFailure).toEqual({
      kind: "connection",
      detail: "initialize answered 401: Unauthorized",
    });
    const result = gradeClaudeReadiness(input);
    const byId = (id: string) => result.findings.find((f) => f.id === id);
    const reason =
      "blocked: the connection to the server failed: initialize answered 401: Unauthorized";
    for (const id of [
      "claude.tools.title-present",
      "claude.apps.csp-shape",
      "claude.submission.access-matches-annotations",
      "claude.scan.cross-tool-direction-candidates",
    ]) {
      expect(byId(id)?.notEvaluatedReason, id).toBe(reason);
    }
    // Discovery needs no session, so its verdicts stand, and a check that
    // was never asked for keeps its own reason.
    expect(byId("claude.auth.unauthenticated-challenge")?.status).toBe(
      "satisfied"
    );
    expect(byId("claude.auth.prm-discoverable")?.status).toBe("satisfied");
    expect(byId("claude.intrusive.refresh-rotation")?.notEvaluatedReason).toBe(
      "intrusive probes were not requested"
    );

    const placed = place(result.findings);
    expect(placed.get("claude.tools.title-present")?.evidenceStatus).toBe(
      "blocked"
    );
    expect(placed.get("claude.auth.prm-discoverable")?.evidenceStatus).toBe(
      "established"
    );
  });
});

describe("a server that answers", () => {
  it("records no failure and rewrites no reason", async () => {
    const input = await gather(async (request, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "HEAD") return new Response(null, { status: 200 });
      if (method !== "POST") return new Response("", { status: 404 });
      const body = JSON.parse(String(init?.body ?? "{}"));
      const result =
        body.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "demo" },
            }
          : body.method === "tools/list"
            ? { tools: [] }
            : { resources: [] };
      return json({ jsonrpc: "2.0", id: body.id, result });
    });
    expect(input.serverFailure).toBeUndefined();
    const result = gradeClaudeReadiness(input);
    expect(
      result.findings.some((f) => f.notEvaluatedReason?.startsWith("blocked: "))
    ).toBe(false);
  });
});
