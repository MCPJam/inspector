/**
 * The Claude gather half and the attributable-evidence adapters.
 *
 * The gather tests pin SYMMETRY with the OpenAI gatherer — gather once,
 * serialize, grade anywhere — and the one rule that makes the dial safe: a
 * listing that did not finish grades nothing.
 *
 * The adapter tests are about the three ways reuse is silently wrong. Each of
 * them renders identically to a correct reuse, and each of them must degrade
 * to MISSING rather than to a verdict.
 */

import { describe, expect, it, vi } from "vitest";

import { adaptAppsResultToClaudeEvidence } from "../../src/claude-readiness/evidence-adapters.js";
import { gatherClaudeReadinessEvidence } from "../../src/claude-readiness/gather.js";
import { parseClaudeExperienceObservations } from "../../src/claude-readiness/observations.js";
import { gradeClaudeReadiness } from "../../src/claude-readiness/runner.js";
import { sameReadinessTarget } from "../../src/directory-readiness/evidence-reuse.js";

const TARGET = "https://connector.example.com/mcp";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const INITIALIZE = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  serverInfo: { name: "demo", version: "1" },
};

const WIDGET_TOOL = {
  name: "show_chart",
  title: "Show chart",
  description: "Render a chart of the requested series.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  _meta: { ui: { resourceUri: "ui://chart" } },
};

/** A transport that answers the whole Claude gather pass from a table. */
function wireFetch(rpc: Record<string, unknown[]>): typeof fetch {
  const cursors: Record<string, number> = {};
  return (async (_url: any, init?: any) => {
    const method = String(init?.method ?? "GET").toUpperCase();
    if (method === "HEAD") return new Response(null, { status: 200 });
    if (method === "GET") return new Response("", { status: 404 });
    const body = JSON.parse(String(init?.body ?? "{}"));
    const rpcMethod = String(body.method);
    const queue = rpc[rpcMethod];
    if (!queue) {
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: "unknown method" },
      });
    }
    // CLAMPED, deliberately: a method called more times than its queue is long
    // keeps receiving the last answer. Two cases below depend on that replay —
    // the pagination walk and the resource walk both need a cursor that never
    // resolves.
    const index = Math.min(cursors[rpcMethod] ?? 0, queue.length - 1);
    cursors[rpcMethod] = (cursors[rpcMethod] ?? 0) + 1;
    return jsonResponse({ jsonrpc: "2.0", id: body.id, result: queue[index] });
  }) as unknown as typeof fetch;
}

const findingById = (
  result: ReturnType<typeof gradeClaudeReadiness>,
  id: string,
) => result.findings.find((finding) => finding.id === id)!;

describe("gatherClaudeReadinessEvidence", () => {
  it("returns evidence that survives a JSON round trip", async () => {
    const evidence = await gatherClaudeReadinessEvidence({
      enteredUrl: TARGET,
      fetchFn: wireFetch({
        initialize: [INITIALIZE],
        "tools/list": [{ tools: [WIDGET_TOOL] }],
        "resources/list": [
          {
            resources: [
              { uri: "ui://chart", mimeType: "text/html;profile=mcp-app" },
            ],
          },
        ],
      }),
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });

    expect(JSON.parse(JSON.stringify(evidence))).toEqual(evidence);
    expect(evidence.tools?.map((tool) => tool.name)).toEqual(["show_chart"]);
    expect(evidence.toolListingComplete).toBe(true);
  });

  it("grades the same result from gathered evidence as from a replay of it", async () => {
    const fetchFn = wireFetch({
      initialize: [INITIALIZE],
      "tools/list": [{ tools: [WIDGET_TOOL] }],
      "resources/list": [{ resources: [] }],
    });
    const evidence = await gatherClaudeReadinessEvidence({
      enteredUrl: TARGET,
      fetchFn,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });

    const direct = gradeClaudeReadiness(evidence);
    const replayed = gradeClaudeReadiness(
      JSON.parse(JSON.stringify(evidence)) as typeof evidence,
    );
    expect(replayed).toEqual(direct);
  });

  it("dials nothing without a transport, and every wire lane says so", async () => {
    const evidence = await gatherClaudeReadinessEvidence({
      enteredUrl: TARGET,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    expect(evidence.tools).toBeUndefined();
    expect(evidence.apps.appsSuiteRan).toBe(false);
    expect(
      findingById(gradeClaudeReadiness(evidence), "claude.tools.title-present")
        .status,
    ).toBe("not-evaluated");
  });

  it("turns a truncated tool listing into a gap rather than a pass", async () => {
    const evidence = await gatherClaudeReadinessEvidence({
      enteredUrl: TARGET,
      fetchFn: wireFetch({
        initialize: [INITIALIZE],
        "tools/list": [{ tools: [WIDGET_TOOL], nextCursor: "more" }],
        "resources/list": [{ resources: [] }],
      }),
      // Bounded here rather than left to the SDK default — see the clamp note
      // in `wireFetch`: this fixture's cursor never resolves.
      maxListPages: 2,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });

    expect(evidence.toolListingComplete).toBe(false);
    const finding = findingById(
      gradeClaudeReadiness(evidence),
      "claude.tools.title-present",
    );
    expect(finding.status).toBe("not-evaluated");
    expect(finding.details).toMatchObject({ missingInput: "toolListing" });
  });

  it("refuses to grade the apps lane from a truncated resource listing", async () => {
    // A widget that fell off the end of a capped listing reads as a server
    // with no widgets, which grades `not-applicable` — a clean bill of health
    // for a page nobody read.
    const evidence = await gatherClaudeReadinessEvidence({
      enteredUrl: TARGET,
      fetchFn: wireFetch({
        initialize: [INITIALIZE],
        "tools/list": [{ tools: [WIDGET_TOOL] }],
        "resources/list": [
          {
            resources: [
              { uri: "ui://chart", mimeType: "text/html;profile=mcp-app" },
            ],
            nextCursor: "more",
          },
        ],
      }),
      maxListPages: 2,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    expect(evidence.apps.appsSuiteRan).toBe(false);
  });

  it("refuses to grade the apps lane from a truncated TOOL listing", async () => {
    // The same hazard wearing the other hat. The apps checks read tools too,
    // so a widget tool that fell off the end takes its `_meta` with it — and a
    // lane that saw no widget tools grades `not-applicable`, over a page
    // nobody finished reading. The tools lane reporting its own gap does not
    // repair this one: they are different claims, and only one was hedged.
    const evidence = await gatherClaudeReadinessEvidence({
      enteredUrl: TARGET,
      fetchFn: wireFetch({
        initialize: [INITIALIZE],
        "tools/list": [{ tools: [WIDGET_TOOL], nextCursor: "more" }],
        "resources/list": [{ resources: [] }],
      }),
      maxListPages: 2,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });

    expect(evidence.toolListingComplete).toBe(false);
    expect(evidence.apps.appsSuiteRan).toBe(false);
    const finding = findingById(
      gradeClaudeReadiness(evidence),
      "claude.apps.resource-uri-modern",
    );
    expect(finding.status).toBe("not-evaluated");
  });

  it("does not dial a listing the caller already holds", async () => {
    const fetchFn = vi.fn(wireFetch({ initialize: [INITIALIZE] }));
    await gatherClaudeReadinessEvidence({
      enteredUrl: TARGET,
      fetchFn: fetchFn as unknown as typeof fetch,
      tools: [WIDGET_TOOL],
      apps: {
        enteredUrl: TARGET,
        appsSuiteRan: true,
        tools: [],
        resources: [],
      },
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    const bodies = fetchFn.mock.calls
      .map(([, init]: any[]) => String(init?.body ?? ""))
      .filter(Boolean);
    expect(bodies.some((body) => body.includes("tools/list"))).toBe(false);
  });

  it("carries a validated observation state through to the result", async () => {
    const parsed = parseClaudeExperienceObservations({
      readinessKind: "claude-directory-readiness",
      observationKind: "experience",
      observationSchemaVersion: "1",
      promptVersion: "1",
      modelId: "anthropic/claude-sonnet-4",
      observedAt: "2026-08-20T00:00:00.000Z",
      observations: [
        {
          id: "claude.experience.connector-purpose-unclear",
          summary: "The listing does not say what the connector is for.",
          confidence: "medium",
          evidenceRefs: ["listing.description"],
        },
      ],
    });
    if (!parsed.ok) throw new Error("fixture should parse");

    const evidence = await gatherClaudeReadinessEvidence({
      enteredUrl: TARGET,
      fetchFn: wireFetch({
        initialize: [INITIALIZE],
        "tools/list": [{ tools: [WIDGET_TOOL] }],
        "resources/list": [{ resources: [] }],
      }),
      llmObservations: { status: "completed", envelope: parsed.envelope },
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });

    const result = gradeClaudeReadiness(evidence);
    const finding = findingById(
      result,
      "claude.experience.connector-purpose-unclear",
    );
    expect(finding.lane).toBe("experience-insights");
    expect(finding.provenance).toBe("llm");
    expect(result.llmObservations?.status).toBe("completed");
  });

  it("keeps a billing denial out of the connector's verdict", async () => {
    const dial = () =>
      wireFetch({
        initialize: [INITIALIZE],
        "tools/list": [{ tools: [WIDGET_TOOL] }],
        "resources/list": [{ resources: [] }],
      });
    const clean = gradeClaudeReadiness(
      await gatherClaudeReadinessEvidence({
        enteredUrl: TARGET,
        fetchFn: dial(),
        now: () => new Date("2026-08-20T00:00:00.000Z"),
      }),
    );
    const blocked = gradeClaudeReadiness(
      await gatherClaudeReadinessEvidence({
        enteredUrl: TARGET,
        fetchFn: dial(),
        llmObservations: {
          status: "billing-blocked",
          reason: "billing_limit_reached",
          detail: "out of credits",
        },
        now: () => new Date("2026-08-20T00:00:00.000Z"),
      }),
    );
    expect(blocked.status).toBe(clean.status);
    expect(blocked.llmObservations?.reason).toBe("billing_limit_reached");
  });
});

describe("attributable evidence adapters", () => {
  /** Every selected check ran. */
  const RAN = [
    { id: "apps.ui.resource-uri", status: "passed" as const },
    { id: "apps.ui.csp", status: "passed" as const },
  ];
  /** One violated, one never ran — the shape `outcome` cannot describe. */
  const PARTLY_RAN = [
    { id: "apps.ui.resource-uri", status: "failed" as const },
    {
      id: "apps.ui.csp",
      status: "skipped" as const,
      skipReason: "could-not-run" as const,
      error: { message: "the widget resource could not be read" },
    },
  ];
  const RESULT = { target: TARGET, outcome: "passed", checks: RAN };
  const CONTENTS = [
    {
      uri: "ui://chart",
      mimeType: "text/html;profile=mcp-app",
      text: "<html></html>",
      _meta: { ui: { domain: "chart.example.com" } },
    },
  ];

  it("adapts a matching, complete result and names the source run", () => {
    const adapted = adaptAppsResultToClaudeEvidence({
      result: RESULT,
      expectation: { target: TARGET },
      runId: "run_123",
      tools: [WIDGET_TOOL],
      resourceContents: CONTENTS,
    });
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    expect(adapted.sourceRef).toBe("apps-conformance:run_123");
    expect(adapted.evidence.appsSuiteRan).toBe(true);
    expect(adapted.evidence.tools?.[0]!.name).toBe("show_chart");
    expect(adapted.evidence.resources?.[0]!.domain).toBe("chart.example.com");
  });

  it("refuses a result that graded a different server", () => {
    const adapted = adaptAppsResultToClaudeEvidence({
      result: {
        target: "https://staging.example.com/mcp",
        outcome: "passed",
        checks: RAN,
      },
      expectation: { target: TARGET },
      resourceContents: CONTENTS,
    });
    expect(adapted.ok).toBe(false);
    if (adapted.ok) return;
    expect(adapted.refusal).toBe("target_mismatch");
  });

  it("refuses a result produced under a different configuration", () => {
    const adapted = adaptAppsResultToClaudeEvidence({
      result: RESULT,
      expectation: { target: TARGET, configFingerprint: "anon" },
      configFingerprint: "with-bearer",
      resourceContents: CONTENTS,
    });
    expect(adapted.ok).toBe(false);
    if (adapted.ok) return;
    expect(adapted.refusal).toBe("config_mismatch");
  });

  it("refuses a source run that never finished", () => {
    const adapted = adaptAppsResultToClaudeEvidence({
      result: { target: TARGET, outcome: "incomplete", checks: PARTLY_RAN },
      expectation: { target: TARGET },
      resourceContents: CONTENTS,
    });
    expect(adapted.ok).toBe(false);
    if (adapted.ok) return;
    expect(adapted.refusal).toBe("source_incomplete");
  });

  it("accepts a FAILED run that did look at everything", () => {
    // A violation is not a reason to refuse the evidence: the run exercised
    // every check it selected, and its findings are what readiness wants.
    const adapted = adaptAppsResultToClaudeEvidence({
      result: {
        target: TARGET,
        outcome: "failed",
        checks: [{ id: "apps.ui.csp", status: "failed" as const }],
      },
      expectation: { target: TARGET },
      resourceContents: CONTENTS,
    });
    expect(adapted.ok).toBe(true);
  });

  it("refuses a FAILED run that stopped looking", () => {
    // `decideConformanceOutcome` returns "failed" on the FIRST violation
    // without counting what never ran, so "failed" cannot mean "finished".
    // Reading it that way adopts the silence of every check that never ran —
    // and an unread widget renders exactly like a compliant one.
    const adapted = adaptAppsResultToClaudeEvidence({
      result: { target: TARGET, outcome: "failed", checks: PARTLY_RAN },
      expectation: { target: TARGET },
      resourceContents: CONTENTS,
    });
    expect(adapted.ok).toBe(false);
    if (adapted.ok) return;
    expect(adapted.refusal).toBe("source_incomplete");
  });

  it("refuses a run that selected no checks at all", () => {
    const adapted = adaptAppsResultToClaudeEvidence({
      result: { target: TARGET, outcome: "passed", checks: [] },
      expectation: { target: TARGET },
      resourceContents: CONTENTS,
    });
    expect(adapted.ok).toBe(false);
  });

  it("leaves the apps lane a named gap when the adaptation is refused", async () => {
    const refused = adaptAppsResultToClaudeEvidence({
      result: {
        target: "https://other.example.com/mcp",
        outcome: "passed",
        checks: RAN,
      },
      expectation: { target: TARGET },
    });
    const evidence = await gatherClaudeReadinessEvidence({
      enteredUrl: TARGET,
      apps: refused.ok ? refused.evidence : undefined,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    const finding = findingById(
      gradeClaudeReadiness(evidence),
      "claude.apps.resource-uri-modern",
    );
    expect(finding.status).toBe("not-evaluated");
    expect(finding.details).toMatchObject({ missingInput: "appsResult" });
  });
});

describe("sameReadinessTarget", () => {
  it.each([
    ["https://a.example.com/mcp", "https://A.example.com/mcp/"],
    ["https://a.example.com/mcp?b=2&a=1", "https://a.example.com/mcp?a=1&b=2"],
    ["https://a.example.com/mcp#frag", "https://a.example.com/mcp"],
  ])("treats %s and %s as one target", (left, right) => {
    expect(sameReadinessTarget(left, right)).toBe(true);
  });

  it.each([
    ["https://a.example.com/mcp", "https://b.example.com/mcp"],
    ["https://a.example.com/mcp", "http://a.example.com/mcp"],
    ["https://a.example.com/mcp", "https://a.example.com/other"],
    [
      "https://a.example.com/mcp?tenant=1",
      "https://a.example.com/mcp?tenant=2",
    ],
  ])("keeps %s and %s apart", (left, right) => {
    expect(sameReadinessTarget(left, right)).toBe(false);
  });
});
