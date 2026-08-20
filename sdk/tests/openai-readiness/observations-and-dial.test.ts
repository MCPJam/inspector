/**
 * The two halves PR 1 added to the OpenAI runner, at runner level.
 *
 * The dial half is a BUG FIX with no visible symptom: before it, a wire run
 * accepted a tool listing as an argument and never fetched one, so every
 * annotation requirement graded `not-evaluated` forever. The tests here pin
 * both the fix and the thing that makes the fix safe — a truncated listing
 * must not become a pass.
 *
 * The observation half is a SAFETY boundary. The assertions worth having are
 * not that a model's output renders; they are that it cannot decide anything.
 */

import { describe, expect, it, vi } from "vitest";

import { toConformanceReport } from "../../src/conformance-reporting.js";
import {
  gatherOpenAIReadinessEvidence,
  gradeOpenAIReadiness,
} from "../../src/openai-readiness/runner.js";
import { parseOpenAIExperienceObservations } from "../../src/openai-readiness/observations.js";
import type { OpenAIReadinessEvidence } from "../../src/openai-readiness/runner.js";

const TARGET = "https://plugin.example.com/mcp";

function jsonRpc(id: unknown, result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A transport that answers the whole gather pass: the redirect HEAD, the
 * domain-verification GET, and every JSON-RPC method from a table.
 */
function wireFetch(rpc: Record<string, unknown[]>): typeof fetch {
  const cursors: Record<string, number> = {};
  return (async (url: any, init?: any) => {
    if ((init?.method ?? "GET") === "HEAD") {
      return new Response(null, { status: 200 });
    }
    if ((init?.method ?? "GET") === "GET") {
      return new Response("", { status: 404 });
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    const method = String(body.method);
    const queue = rpc[method];
    if (!queue) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "unknown method" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const index = Math.min(cursors[method] ?? 0, queue.length - 1);
    cursors[method] = (cursors[method] ?? 0) + 1;
    return jsonRpc(body.id, queue[index]);
  }) as unknown as typeof fetch;
}

const INITIALIZE = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  serverInfo: { name: "demo", version: "1" },
};

const WELL_ANNOTATED = {
  name: "search_docs",
  description: "Search the documentation corpus for a phrase.",
  inputSchema: { type: "object", properties: {} },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
};

const findingById = (
  evidence: ReturnType<typeof gradeOpenAIReadiness>,
  id: string,
) => evidence.findings.find((finding) => finding.id === id)!;

describe("the gatherer dials tools/list", () => {
  it("produces tool evidence a wire run previously never had", async () => {
    const evidence = await gatherOpenAIReadinessEvidence({
      target: TARGET,
      mode: "mcp-only",
      fetchFn: wireFetch({
        initialize: [INITIALIZE],
        "tools/list": [{ tools: [WELL_ANNOTATED] }],
      }),
    });

    expect(evidence.tools?.map((tool) => tool.name)).toEqual(["search_docs"]);
    expect(evidence.toolListingComplete).toBe(true);

    const result = gradeOpenAIReadiness(evidence);
    expect(findingById(result, "openai.tools.annotations").status).toBe(
      "satisfied",
    );
  });

  it("does not dial when the caller already holds an attributable listing", async () => {
    const fetchFn = vi.fn(wireFetch({ initialize: [INITIALIZE] }));
    const evidence = await gatherOpenAIReadinessEvidence({
      target: TARGET,
      mode: "mcp-only",
      fetchFn: fetchFn as unknown as typeof fetch,
      tools: [WELL_ANNOTATED],
    });

    const bodies = fetchFn.mock.calls
      .map(([, init]: any[]) => String(init?.body ?? ""))
      .filter(Boolean);
    expect(bodies.some((body) => body.includes("tools/list"))).toBe(false);
    expect(evidence.tools).toHaveLength(1);
    // No claim was made about a caller-supplied listing, and the grader treats
    // that as the caller having already decided.
    expect(evidence.toolListingComplete).toBeUndefined();
    expect(
      findingById(gradeOpenAIReadiness(evidence), "openai.tools.annotations")
        .status,
    ).toBe("satisfied");
  });

  it("turns a truncated listing into a coverage gap rather than a pass", async () => {
    const evidence = await gatherOpenAIReadinessEvidence({
      target: TARGET,
      mode: "mcp-only",
      fetchFn: wireFetch({
        initialize: [INITIALIZE],
        // A cursor that never resolves: the walk stops and says so.
        "tools/list": [{ tools: [WELL_ANNOTATED], nextCursor: "more" }],
      }),
      // BOUNDED HERE rather than left to the SDK default. The harness replays
      // its last queued answer forever, so a fixture that named no bound would
      // hang until the suite timeout if that default were ever raised — and a
      // hanging test says far less than a failing one.
      maxListPages: 2,
    });

    expect(evidence.toolListingComplete).toBe(false);
    const result = gradeOpenAIReadiness(evidence);
    const finding = findingById(result, "openai.tools.annotations");
    expect(finding.status).toBe("not-evaluated");
    expect(finding.details).toMatchObject({ missingInput: "toolListing" });
    // And the gap reaches the lane's coverage, so a reader is told how to
    // close it. The lane's own STATUS is not asserted here: this fixture also
    // fails the domain-verification check, and `not-ready` correctly dominates
    // `incomplete` — a real violation is not softened by an unrelated gap.
    const lane = result.lanes.find(
      (entry) => entry.lane === "directory-policy",
    )!;
    expect(lane.coverage.missingInputs).toContain("toolListing");
    expect(lane.coverage.notEvaluated).toBeGreaterThan(0);
  });

  it("reports an unreachable server without inventing a tool listing", async () => {
    const evidence = await gatherOpenAIReadinessEvidence({
      target: TARGET,
      mode: "mcp-only",
      fetchFn: (async (_url: any, init?: any) => {
        if ((init?.method ?? "GET") !== "POST") {
          return new Response(null, { status: 200 });
        }
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });
    // AN EMPTY LISTING MARKED INCOMPLETE, not an absent one — and the pairing
    // is the whole point. `[]` alone would read as "this server advertises no
    // tools", which grades `not-applicable`; `complete: false` beside it says
    // nobody established that. The REASON survives too, which is what turns
    // the gap into something a submitter can act on: "the server refused"
    // sends them somewhere, "this run was given no tool listing" sends them
    // to us.
    expect(evidence.tools).toEqual([]);
    expect(evidence.toolListingComplete).toBe(false);
    expect(evidence.toolListingError).toBeDefined();
    const finding = findingById(
      gradeOpenAIReadiness(evidence),
      "openai.tools.annotations",
    );
    expect(finding.status).toBe("not-evaluated");
    expect(finding.notEvaluatedReason).toContain("ECONNRESET");
  });
});

describe("model observations in a graded result", () => {
  const parsedEnvelope = parseOpenAIExperienceObservations({
    readinessKind: "openai-directory-readiness",
    observationKind: "experience",
    observationSchemaVersion: "1",
    promptVersion: "1",
    modelId: "anthropic/claude-sonnet-4",
    observedAt: "2026-08-20T00:00:00.000Z",
    observations: [
      {
        id: "openai.experience.tool-overlap",
        summary: "search_docs and find_docs appear to cover the same job.",
        confidence: "high",
        evidenceRefs: ["tools/search_docs", "tools/find_docs"],
      },
    ],
  });
  if (!parsedEnvelope.ok) throw new Error("fixture should parse");
  const envelope = parsedEnvelope.envelope;

  async function gradedWithObservations(
    llmObservations: OpenAIReadinessEvidence["llmObservations"],
  ) {
    const evidence = await gatherOpenAIReadinessEvidence({
      target: TARGET,
      mode: "mcp-only",
      fetchFn: wireFetch({
        initialize: [INITIALIZE],
        "tools/list": [{ tools: [WELL_ANNOTATED] }],
      }),
      llmObservations,
    });
    return gradeOpenAIReadiness(evidence);
  }

  it("defaults to not-requested, and a free run says so explicitly", async () => {
    const result = await gradedWithObservations(undefined);
    expect(result.llmObservations?.status).toBe("not-requested");
    expect(result.llmObservations?.reason).toBe("not_requested");
  });

  it("renders an observation as a non-dispositive experience finding", async () => {
    const result = await gradedWithObservations({
      status: "completed",
      envelope,
    });
    const finding = findingById(result, "openai.experience.tool-overlap");
    expect(finding.lane).toBe("experience-insights");
    expect(finding.class).toBe("heuristic");
    expect(finding.provenance).toBe("llm");
    expect(finding.status).toBe("informational");
  });

  it("cannot move a required lane or the headline verdict", async () => {
    const without = await gradedWithObservations(undefined);
    const withAi = await gradedWithObservations({
      status: "completed",
      envelope,
    });

    expect(withAi.status).toBe(without.status);
    for (const lane of withAi.lanes) {
      const before = without.lanes.find((entry) => entry.lane === lane.lane)!;
      expect(lane.status).toBe(before.status);
    }
    expect(withAi.stages.map((stage) => stage.status)).toEqual(
      without.stages.map((stage) => stage.status),
    );
  });

  it("reports a billing denial as a readiness gap, never as a target failure", async () => {
    const blocked = await gradedWithObservations({
      status: "billing-blocked",
      reason: "billing_limit_reached",
      detail: "the organization is out of MCPJam credits",
    });
    const clean = await gradedWithObservations(undefined);

    expect(blocked.llmObservations?.reason).toBe("billing_limit_reached");
    // Same verdict as the run that never asked: a payment problem belongs to
    // the account, not to the server under grading.
    expect(blocked.status).toBe(clean.status);
    const violatedIds = (result: typeof blocked) =>
      result.findings
        .filter((finding) => finding.status === "violated")
        .map((finding) => finding.id)
        .sort();
    expect(violatedIds(blocked)).toEqual(violatedIds(clean));
  });

  it("reports invalid provider output without adding a finding", async () => {
    const invalid = await gradedWithObservations({
      status: "invalid-output",
      reason: "schema_invalid",
      detail: "observations[0].id is not a published observation id",
    });
    expect(
      invalid.findings.some((finding) => finding.provenance === "llm"),
    ).toBe(false);
    expect(invalid.llmObservations?.status).toBe("invalid-output");
  });

  it("renders AI findings as report advisories rather than testcases", async () => {
    const result = await gradedWithObservations({
      status: "completed",
      envelope,
    });
    const report = toConformanceReport(result);
    const advisoryIds = (report.advisories ?? []).map(
      (advisory) => advisory.id ?? advisory.title,
    );
    const caseIds = report.groups.flatMap((group) =>
      group.cases.map((entry) => entry.id ?? entry.name),
    );
    expect(
      advisoryIds.some((id) => String(id).includes("experience.tool-overlap")),
    ).toBe(true);
    expect(
      caseIds.some((id) => String(id).includes("experience.tool-overlap")),
    ).toBe(false);
  });
});
