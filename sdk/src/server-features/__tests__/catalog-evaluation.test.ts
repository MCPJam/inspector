/**
 * The whole catalog through the evaluator, for a few realistic servers. Rule
 * tests cover each row; this catches rows that throw, contradict their family
 * or turn missing data into gaps once everything is put together.
 */

import { describe, expect, it } from "vitest";
import { SERVER_FEATURE_CATALOG } from "../catalog/index.js";
import { evaluateServerFeatures } from "../evaluate.js";
import { toDeclaredSurface } from "../declared-surface.js";
import type { ServerFeatureEvaluation, ServerFeatureEvidenceInput } from "../types.js";
import { fullCoverage, makeProbe, makeSurface } from "./fixtures.js";

const leafIds = SERVER_FEATURE_CATALOG.filter(
  (feature) => !SERVER_FEATURE_CATALOG.some((other) => other.parent === feature.id),
).map((feature) => feature.id);

function familyStates(result: ServerFeatureEvaluation, family: string) {
  return SERVER_FEATURE_CATALOG.filter(
    (feature) => feature.family === family && leafIds.includes(feature.id),
  ).map((feature) => result.assessments[feature.id].state);
}

function brokenRules(result: ServerFeatureEvaluation) {
  return Object.values(result.assessments).filter((assessment) =>
    assessment.reason?.includes("rule failed"),
  );
}

describe("full catalog evaluation", () => {
  it("covers every leaf once and sums its counts", () => {
    const result = evaluateServerFeatures(SERVER_FEATURE_CATALOG, { connected: false });
    const total = Object.values(result.totals).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(leafIds.length);
    expect(leafIds.length).toBeGreaterThan(240);
    expect(result.cards.reduce((sum, card) => sum + card.leafCount, 0)).toBe(total);
  });

  it("asks a never-connected server to connect and invents no gaps", () => {
    const result = evaluateServerFeatures(SERVER_FEATURE_CATALOG, { connected: false });
    expect(result.totals["could-add"]).toBe(0);
    expect(result.totals.supported).toBe(0);
    expect(result.totals["check-failed"]).toBe(0);
    expect(brokenRules(result)).toEqual([]);
  });

  it("marks HTTP-only families not applicable on stdio", () => {
    const surface = makeSurface({
      transport: "stdio",
      capabilities: { tools: {} },
      tools: [{ name: "echo", inputSchema: { type: "object" } }],
    });
    const result = evaluateServerFeatures(SERVER_FEATURE_CATALOG, {
      connected: true,
      context: { transport: "stdio", protocolVersion: "2025-11-25" },
      declared: { surface, capturedAt: 1 },
    });
    expect(brokenRules(result)).toEqual([]);
    // Stdio-specific behavior rows still apply; every HTTP row does not.
    const httpRows = SERVER_FEATURE_CATALOG.filter(
      (feature) =>
        feature.family === "transport-behavior" && !feature.id.includes("stdio"),
    );
    expect(httpRows.length).toBeGreaterThan(10);
    for (const feature of httpRows) {
      expect(result.assessments[feature.id].state).toBe("not-applicable");
    }
    for (const state of familyStates(result, "core-authorization")) {
      expect(["not-applicable", "not-checked"]).toContain(state);
    }
    expect(result.assessments["tools.capability"]?.state ?? "supported").toBe("supported");
  });

  it("finds opportunities only where a complete capture shows absence", () => {
    const surface = makeSurface({
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: false } },
      tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
    });
    const complete = evaluateServerFeatures(SERVER_FEATURE_CATALOG, {
      connected: true,
      context: { transport: "streamable-http", protocolVersion: "2025-11-25", clientExtensions: ["io.modelcontextprotocol/ui"] },
      declared: { surface, capturedAt: 1 },
    });
    expect(brokenRules(complete)).toEqual([]);
    expect(complete.totals["could-add"]).toBeGreaterThan(0);

    const partial = evaluateServerFeatures(SERVER_FEATURE_CATALOG, {
      connected: true,
      context: { transport: "streamable-http", protocolVersion: "2025-11-25", clientExtensions: ["io.modelcontextprotocol/ui"] },
      declared: {
        surface: { ...surface, coverage: fullCoverage({ capabilities: "partial", tools: "partial", toolMeta: "partial", toolSchemas: "partial", resources: "not-captured", prompts: "not-captured", resourceTemplates: "not-captured", serverInfo: "partial" }) },
        capturedAt: 1,
      },
    });
    expect(partial.totals["could-add"]).toBeLessThan(complete.totals["could-add"]);
  });

  it("never offers gaps at an unknown future revision", () => {
    const surface = makeSurface({ protocolVersion: "2027-09-01", capabilities: {} });
    const result = evaluateServerFeatures(SERVER_FEATURE_CATALOG, {
      connected: true,
      context: { transport: "streamable-http", protocolVersion: "2027-09-01", clientExtensions: [] },
      declared: { surface, capturedAt: 1 },
    });
    expect(result.totals["could-add"]).toBe(0);
    expect(brokenRules(result)).toEqual([]);
  });

  it("labels rows that only read a listing or metadata as declared", () => {
    const surface = makeSurface({ capabilities: { tools: {}, events: {} } });
    const result = evaluateServerFeatures(SERVER_FEATURE_CATALOG, {
      connected: true,
      context: {
        transport: "streamable-http",
        protocolVersion: surface.protocolVersion,
        clientExtensions: ["io.modelcontextprotocol/ui"],
      },
      declared: { surface, capturedAt: 1 },
      probes: {
        "events-list": makeProbe("events-list", {
          listed: true,
          eventCount: 1,
          deliveryModes: ["poll"],
        }),
        authorization: makeProbe("authorization", {
          oauthRequired: true,
          asMetadataFound: true,
          codeChallengeMethods: ["S256"],
        }),
        "apps-ui-resources": makeProbe("apps-ui-resources", {
          uiResourceCount: 1,
          readCount: 1,
          cspDeclared: true,
        }),
      },
    });
    expect(brokenRules(result)).toEqual([]);
    // events/list naming poll and S256 in the metadata are declarations; a
    // policy field in the read UI content is a hint. None was seen working.
    expect(result.assessments["events.poll"].sources).toEqual(["declared"]);
    expect(result.assessments["auth.pkce"].sources).toEqual(["declared"]);
    expect(result.assessments["apps.csp"].sources).toEqual(["detected"]);
    // A 401 that asks for OAuth is behaviour MCPJam saw.
    expect(result.assessments["auth.oauth"].sources[0]).toBe("probed");
    // A parent with no rule of its own carries its child's chip.
    expect(result.assessments["apps.resource-content"]).toMatchObject({
      state: "supported",
      sources: ["detected"],
    });
  });

  it("credits cancellation only where a server may send one", () => {
    const cancelled = {
      featureId: "request-control.cancellation",
      count: 1,
      firstSeenAt: 1,
      lastSeenAt: 2,
      lastSource: "rpc" as const,
    };
    const legacy = makeSurface({ protocolVersion: "2025-11-25" });
    const seen = evaluateServerFeatures(SERVER_FEATURE_CATALOG, {
      connected: true,
      context: { transport: "stdio", protocolVersion: "2025-11-25" },
      declared: { surface: legacy, capturedAt: 1 },
      observations: [cancelled],
    });
    expect(seen.assessments["request-control.cancellation"]).toMatchObject({
      state: "supported",
      sources: ["observed"],
    });

    // On 2026-07-28 traffic cannot show it, so no Playground step.
    const modern = makeSurface({ protocolVersion: "2026-07-28" });
    const result = evaluateServerFeatures(SERVER_FEATURE_CATALOG, {
      connected: true,
      context: { transport: "stdio", protocolVersion: "2026-07-28" },
      declared: { surface: modern, capturedAt: 1 },
    });
    expect(result.assessments["request-control.cancellation"]).toMatchObject({
      state: "not-checked",
      reason: "MCPJam cannot check this yet.",
    });
    expect(
      result.assessments["request-control.cancellation"].nextAction
    ).toBeUndefined();
  });

  it("reads a stored 2026 snapshot with an MCP Apps tool end to end", () => {
    const surface = toDeclaredSurface({
      envelopeVersion: 3,
      snapshot: {
        serverId: "srv",
        transport: "streamable-http",
        tools: [
          {
            name: "create_board",
            title: "Create board",
            metaJson: JSON.stringify({ ui: { resourceUri: "ui://board/app.html" } }),
            inputSchema: { type: "object" },
          },
        ],
        resources: [{ uri: "ui://board/app.html", name: "board", mimeType: "text/html;profile=mcp-app" }],
        discovery: {
          protocolVersion: "2026-07-28",
          supportedVersions: ["2026-07-28"],
          serverInfo: { name: "board", version: "1.0.0" },
          capabilities: { tools: {}, resources: {} },
        },
        coverage: Object.fromEntries(
          ["serverInfo", "capabilities", "instructions", "tools", "toolMeta", "toolSchemas", "resources", "resourceTemplates", "prompts", "skills", "listHints"].map((key) => [key, "complete"]),
        ),
      },
    });
    expect(surface).toBeDefined();
    const input: ServerFeatureEvidenceInput = {
      connected: true,
      context: {
        transport: "streamable-http",
        protocolVersion: "2026-07-28",
        clientExtensions: ["io.modelcontextprotocol/ui"],
      },
      declared: { surface: surface!, capturedAt: 1 },
    };
    const result = evaluateServerFeatures(SERVER_FEATURE_CATALOG, input);
    expect(brokenRules(result)).toEqual([]);
    const apps = familyStates(result, "mcp-apps");
    expect(apps).toContain("supported");
    expect(result.assessments["lifecycle.initialize"]?.state ?? "not-applicable").toBe("not-applicable");
  });
});
