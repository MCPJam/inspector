import { describe, expect, it, vi } from "vitest";

vi.mock("../check-map/index.js", () => {
  const MAPPED: Record<string, string[]> = {
    "protocol:tools-list": ["test.tools", "test.checked"],
    "apps:ui-resources-readable": ["test.tools"],
    "events:events-poll": ["test.events-only"],
  };
  return {
    featuresForCheck: (ref: string) => MAPPED[ref] ?? [],
    checksForFeature: (id: string) =>
      Object.keys(MAPPED).filter((ref) => MAPPED[ref].includes(id)),
  };
});

import { evaluateServerFeatures } from "../evaluate.js";
import { coreSpec } from "../catalog/spec-refs.js";
import type {
  FeatureDefinition,
  FeatureRuleOutcome,
  ServerFeatureEvidenceInput,
} from "../types.js";
import { fullCoverage, makeProbe, makeSurface } from "./fixtures.js";

function feature(
  id: string,
  overrides: Partial<FeatureDefinition> = {},
): FeatureDefinition {
  return {
    id,
    family: "tools-discovery",
    name: id,
    summary: "Test feature.",
    howTo: "Add it.",
    owner: "server",
    spec: coreSpec("2025-11-25", "server/tools"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: { primary: "declared" },
    ...overrides,
  };
}

const capability =
  (key: string) =>
  (surface: { capabilities?: Record<string, unknown> }): FeatureRuleOutcome =>
    surface.capabilities && key in surface.capabilities
      ? { kind: "present", via: "advertised" }
      : { kind: "absent", basis: ["capabilities"] };

function connected(
  overrides: Partial<ServerFeatureEvidenceInput> = {},
  surface = makeSurface(),
): ServerFeatureEvidenceInput {
  return {
    connected: true,
    context: { transport: "streamable-http", protocolVersion: surface.protocolVersion },
    declared: { surface, capturedAt: 1_700_000_000_000 },
    ...overrides,
  };
}

const tools = feature("test.tools", {
  assessment: { primary: "declared", declared: capability("tools") },
});

describe("evaluateServerFeatures", () => {
  it("marks a declared capability supported with its source", () => {
    const surface = makeSurface({ capabilities: { tools: {} } });
    const result = evaluateServerFeatures([tools], connected({}, surface));
    expect(result.assessments["test.tools"]).toMatchObject({
      state: "supported",
      sources: ["declared"],
      applicability: "applies",
    });
  });

  it("reports detected evidence as its own source", () => {
    const detected = feature("test.detected", {
      assessment: {
        primary: "declared",
        declared: () => ({ kind: "present", via: "detected", count: 2 }),
      },
    });
    const result = evaluateServerFeatures([detected], connected());
    expect(result.assessments["test.detected"].sources).toEqual(["detected"]);
    expect(result.assessments["test.detected"].evidence[0].count).toBe(2);
  });

  it("labels a probe that only read a listing as declared", () => {
    const listed = feature("test.listed", {
      assessment: {
        primary: "probed",
        probed: () => ({ kind: "present", via: "advertised" }),
      },
    });
    const result = evaluateServerFeatures([listed], connected({ probes: {} }));
    expect(result.assessments["test.listed"]).toMatchObject({
      state: "supported",
      sources: ["declared"],
    });
    // How it was fetched is still recorded.
    expect(result.assessments["test.listed"].evidence[0]).toMatchObject({
      provenance: "wire",
      intrusiveness: "read-only",
    });
  });

  it("puts what MCPJam saw ahead of what the server declared", () => {
    const both = feature("test.both", {
      assessment: {
        primary: "observed",
        observable: true,
        declared: () => ({ kind: "present", via: "advertised" }),
      },
    });
    const result = evaluateServerFeatures(
      [both],
      connected({
        observations: [
          {
            featureId: "test.both",
            count: 1,
            firstSeenAt: 1,
            lastSeenAt: 2,
            lastSource: "rpc",
          },
        ],
      })
    );
    expect(result.assessments["test.both"].sources).toEqual([
      "observed",
      "declared",
    ]);
  });

  it("offers Could add only when the basis was captured completely", () => {
    const complete = evaluateServerFeatures([tools], connected());
    expect(complete.assessments["test.tools"].state).toBe("could-add");

    const partial = makeSurface({ coverage: fullCoverage({ capabilities: "partial" }) });
    const result = evaluateServerFeatures([tools], connected({}, partial));
    expect(result.assessments["test.tools"]).toMatchObject({
      state: "not-checked",
      nextAction: "reconnect",
    });
  });

  it("never offers Could add at a protocol version it does not know", () => {
    const surface = makeSurface({ protocolVersion: "2027-03-01" });
    const result = evaluateServerFeatures([tools], connected({}, surface));
    expect(result.assessments["test.tools"].state).toBe("not-checked");
    expect(result.assessments["test.tools"].reason).toContain("2027-03-01");
  });

  it("asks for a newer version when the feature was added later", () => {
    const later = feature("test.later", {
      lifecycle: { introduced: "2026-07-28" },
      assessment: { primary: "declared", declared: capability("later") },
    });
    const result = evaluateServerFeatures([later], connected());
    expect(result.assessments["test.later"]).toMatchObject({
      state: "needs-newer",
      applicability: "not-yet",
      nextAction: "upgrade-version",
    });
  });

  it("treats removed and deprecated features as no gap", () => {
    const removed = feature("test.removed", {
      lifecycle: { removed: "2026-07-28" },
      assessment: { primary: "declared", declared: capability("ping") },
    });
    const deprecated = feature("test.deprecated", {
      lifecycle: { deprecated: "2026-07-28" },
      assessment: { primary: "declared", declared: capability("logging") },
    });
    const surface = makeSurface({ protocolVersion: "2026-07-28" });
    const result = evaluateServerFeatures(
      [removed, deprecated],
      connected({}, surface),
    );
    expect(result.assessments["test.removed"]).toMatchObject({
      state: "not-applicable",
      markers: ["removed"],
    });
    expect(result.assessments["test.deprecated"]).toMatchObject({
      state: "not-applicable",
      markers: ["deprecated"],
    });
  });

  it("never makes a client-owned feature a gap", () => {
    const client = feature("test.client", {
      owner: "client",
      assessment: { primary: "declared", declared: capability("roots") },
    });
    const result = evaluateServerFeatures([client], connected());
    expect(result.assessments["test.client"].state).toBe("needs-newer");
  });

  it("lets a failed check win over a declaration", () => {
    const surface = makeSurface({ capabilities: { tools: {} } });
    const result = evaluateServerFeatures(
      [tools],
      connected(
        {
          checks: [
            {
              ref: "protocol:tools-list",
              status: "failed",
              runId: "run_1",
              runAt: 5,
              protocolVersion: "2025-11-25",
            },
          ],
        },
        surface,
      ),
    );
    expect(result.assessments["test.tools"]).toMatchObject({
      state: "check-failed",
      sources: ["checked"],
    });
  });

  it("ignores a check from another protocol version", () => {
    const result = evaluateServerFeatures(
      [tools],
      connected({
        checks: [
          {
            ref: "protocol:tools-list",
            status: "failed",
            runId: "run_1",
            runAt: 5,
            protocolVersion: "2026-07-28",
          },
        ],
      }),
    );
    expect(result.assessments["test.tools"].state).toBe("could-add");
  });

  it("counts a failed read-only probe check as a failed check", () => {
    const result = evaluateServerFeatures(
      [tools],
      connected({
        probes: {
          "apps-ui-resources": makeProbe(
            "apps-ui-resources",
            { uiResourceCount: 1 },
            { checks: { "apps:ui-resources-readable": "failed" } },
          ),
        },
      }),
    );
    expect(result.assessments["test.tools"].state).toBe("check-failed");
  });

  it("marks observed features supported with the observation count", () => {
    const observed = feature("test.observed", {
      assessment: { primary: "observed", observable: true },
    });
    const result = evaluateServerFeatures(
      [observed],
      connected({
        observations: [
          {
            featureId: "test.observed",
            count: 4,
            firstSeenAt: 1,
            lastSeenAt: 9,
            lastSource: "rpc",
          },
        ],
      }),
    );
    expect(result.assessments["test.observed"]).toMatchObject({
      state: "supported",
      sources: ["observed"],
      seenAt: 9,
    });
  });

  it("names the next step when there is no evidence", () => {
    const observed = feature("test.observed", {
      assessment: { primary: "observed", observable: true },
    });
    const checked = feature("test.checked", { assessment: { primary: "checked" } });
    const setup = feature("test.setup", {
      assessment: { primary: "configured", setup: "client-credentials" },
    });
    const result = evaluateServerFeatures(
      [observed, checked, setup],
      connected({ setupOffered: ["client-credentials"] }),
    );
    expect(result.assessments["test.observed"].nextAction).toBe("use-in-playground");
    expect(result.assessments["test.checked"].nextAction).toBe("run-checks");
    expect(result.assessments["test.setup"].nextAction).toBe("set-up");
  });

  it("offers only a step that can produce evidence for the feature", () => {
    const unobservable = feature("test.unobservable", {
      assessment: { primary: "observed" },
    });
    const eventsOnly = feature("test.events-only", {
      assessment: { primary: "checked" },
    });
    const result = evaluateServerFeatures(
      [unobservable, eventsOnly],
      connected({ checksOffered: ["protocol", "apps", "tasks", "oauth"] }),
    );
    for (const id of ["test.unobservable", "test.events-only"]) {
      expect(result.assessments[id]).toMatchObject({
        state: "not-checked",
        reason: "MCPJam cannot check this yet.",
      });
      expect(result.assessments[id].nextAction).toBeUndefined();
    }
    const anySuite = evaluateServerFeatures([eventsOnly], connected());
    expect(anySuite.assessments["test.events-only"].nextAction).toBe("run-checks");
  });

  it("offers Refresh before the probes run and nothing once they said nothing", () => {
    const probed = feature("test.probed", {
      assessment: { primary: "probed", probed: () => null },
    });
    const before = evaluateServerFeatures([probed], connected());
    expect(before.assessments["test.probed"].nextAction).toBe("refresh");
    const after = evaluateServerFeatures(
      [probed],
      connected({ probes: { "http-transport": makeProbe("http-transport", {}) } }),
    );
    expect(after.assessments["test.probed"]).toMatchObject({
      reason: "MCPJam cannot check this yet.",
    });
    expect(after.assessments["test.probed"].nextAction).toBeUndefined();
  });

  it("asks to reconnect only while nothing was captured", () => {
    const declared = feature("test.declared", {
      assessment: { primary: "declared", declared: () => null },
    });
    const captured = evaluateServerFeatures([declared], connected());
    expect(captured.assessments["test.declared"].nextAction).toBeUndefined();
    const notCaptured = evaluateServerFeatures([declared], {
      connected: true,
      context: { transport: "streamable-http" },
    });
    expect(notCaptured.assessments["test.declared"].nextAction).toBe("reconnect");
  });

  it("says when an OAuth sign-in records the feature instead of offering Reconnect", () => {
    const oauth = feature("test.oauth", {
      assessment: { primary: "oauth-flow", oauthFlow: () => null },
    });
    const result = evaluateServerFeatures([oauth], connected());
    expect(result.assessments["test.oauth"]).toMatchObject({
      state: "not-checked",
      reason: "Recorded the next time you sign in to this server with OAuth.",
    });
    expect(result.assessments["test.oauth"].nextAction).toBeUndefined();
  });

  it("never counts setup in MCPJam as the server supporting a feature", () => {
    const setup = feature("test.setup", {
      assessment: { primary: "configured", setup: "client-credentials" },
    });
    const offered = {
      configured: ["client-credentials"] as const,
      setupOffered: ["client-credentials"] as const,
    };
    const configured = evaluateServerFeatures([setup], connected(offered));
    expect(configured.assessments["test.setup"]).toMatchObject({
      state: "not-checked",
      reason:
        "Set up in MCPJam. Reconnect the account from the Auth tab to record the result.",
      evidence: [],
    });
    // Reconnecting with saved tokens records nothing, so no Reconnect step.
    expect(configured.assessments["test.setup"].nextAction).toBeUndefined();
    const notConnected = evaluateServerFeatures([setup], {
      connected: false,
      ...offered,
    });
    expect(notConnected.assessments["test.setup"].nextAction).toBe("connect");
  });

  it("keeps Connect for a set-up server whose only evidence is an inconclusive probe", () => {
    const setup = feature("test.setup", {
      assessment: {
        primary: "configured",
        setup: "client-credentials",
        probed: () => ({
          kind: "unknown",
          reason: "The probe could not finish.",
        }),
      },
    });
    const result = evaluateServerFeatures([setup], {
      connected: false,
      probes: { authorization: makeProbe("authorization", {}) },
      configured: ["client-credentials"],
      setupOffered: ["client-credentials"],
    });
    expect(result.assessments["test.setup"]).toMatchObject({
      reason: "The probe could not finish.",
      nextAction: "connect",
    });
    const connectedSetUp = evaluateServerFeatures([setup], {
      connected: true,
      probes: { authorization: makeProbe("authorization", {}) },
      configured: ["client-credentials"],
      setupOffered: ["client-credentials"],
    });
    expect(connectedSetUp.assessments["test.setup"].reason).toBe(
      "The probe could not finish. Set up in MCPJam. Reconnect the account from the Auth tab to record the result."
    );
  });

  it("asks for setup before connecting a server that never connected", () => {
    const setup = feature("test.setup", {
      assessment: { primary: "configured", setup: "client-credentials" },
    });
    const result = evaluateServerFeatures([setup], {
      connected: false,
      setupOffered: ["client-credentials"],
    });
    expect(result.assessments["test.setup"].nextAction).toBe("set-up");
  });

  it("offers no Set up step for setup this MCPJam surface cannot do", () => {
    const setup = feature("test.setup", {
      assessment: { primary: "configured", setup: "client-credentials" },
    });
    const result = evaluateServerFeatures(
      [setup],
      connected({ setupOffered: ["enterprise-managed-authorization"] }),
    );
    expect(result.assessments["test.setup"]).toMatchObject({
      state: "not-checked",
      reason: "MCPJam cannot check this yet.",
    });
    expect(result.assessments["test.setup"].nextAction).toBeUndefined();
  });

  it("asks to connect a server that was never connected", () => {
    const result = evaluateServerFeatures([tools], { connected: false });
    expect(result.assessments["test.tools"]).toMatchObject({
      state: "not-checked",
      nextAction: "connect",
    });
  });

  it("honors a not-applicable rule outcome", () => {
    const http = feature("test.http", {
      family: "transport-behavior",
      assessment: {
        primary: "probed",
        probed: () => ({ kind: "not-applicable", reason: "stdio server" }),
      },
    });
    const result = evaluateServerFeatures([http], connected({ probes: {} }));
    expect(result.assessments["test.http"]).toMatchObject({
      state: "not-applicable",
      applicability: "not-applicable",
      reason: "stdio server",
    });
  });

  it("turns a throwing rule into Not checked yet", () => {
    const broken = feature("test.broken", {
      assessment: {
        primary: "declared",
        declared: () => {
          throw new Error("boom");
        },
      },
    });
    const result = evaluateServerFeatures([broken], connected());
    expect(result.assessments["test.broken"].state).toBe("not-checked");
    expect(result.assessments["test.broken"].reason).toContain("boom");
  });

  it("uses OAuth-flow summaries as evidence", () => {
    const iss = feature("test.iss", {
      family: "core-authorization",
      assessment: {
        primary: "oauth-flow",
        oauthFlow: (summary) =>
          summary.issValidated
            ? { kind: "present", via: "oauth-flow" }
            : { kind: "absent", basis: [] },
      },
    });
    const result = evaluateServerFeatures(
      [iss],
      connected({
        oauthFlow: {
          completedAt: 3,
          resourceIndicatorSent: true,
          scopesRequested: [],
          scopesGranted: [],
          issReturned: true,
          issValidated: true,
          refreshTokenIssued: false,
        },
      }),
    );
    expect(result.assessments["test.iss"]).toMatchObject({
      state: "supported",
      sources: ["oauth-flow"],
    });
  });

  it("counts leaves only and rolls parent state up from children", () => {
    const parent = feature("test.parent");
    const childA = feature("test.parent.a", {
      parent: "test.parent",
      assessment: { primary: "declared", declared: capability("a") },
    });
    const childB = feature("test.parent.b", {
      parent: "test.parent",
      assessment: { primary: "declared", declared: capability("b") },
    });
    const surface = makeSurface({ capabilities: { a: {} } });
    const result = evaluateServerFeatures(
      [parent, childA, childB],
      connected({}, surface),
    );
    expect(result.assessments["test.parent"].state).toBe("supported");
    expect(result.totals.supported).toBe(1);
    expect(result.totals["could-add"]).toBe(1);
    const card = result.cards.find((entry) => entry.id === "server-features");
    expect(card?.leafCount).toBe(2);
    const family = result.families.find((entry) => entry.id === "tools-discovery");
    expect(family?.counts.supported).toBe(1);
  });

  it("offers the Playground only where traffic can show the feature", () => {
    const legacyOnly = feature("test.legacy-only", {
      assessment: {
        primary: "observed",
        observable: true,
        observableEra: "legacy",
      },
    });
    const modern = makeSurface({ protocolVersion: "2026-07-28" });
    const onModern = evaluateServerFeatures(
      [legacyOnly],
      connected({}, modern)
    );
    expect(onModern.assessments["test.legacy-only"]).toMatchObject({
      state: "not-checked",
      reason: "MCPJam cannot check this yet.",
    });
    expect(onModern.assessments["test.legacy-only"].nextAction).toBeUndefined();

    const onLegacy = evaluateServerFeatures([legacyOnly], connected());
    expect(onLegacy.assessments["test.legacy-only"].nextAction).toBe(
      "use-in-playground"
    );
  });

  it("gives a rolled-up parent the chip of its supported children", () => {
    const parent = feature("test.parent");
    const declaredChild = feature("test.parent.a", {
      parent: "test.parent",
      assessment: { primary: "declared", declared: capability("a") },
    });
    const observedChild = feature("test.parent.b", {
      parent: "test.parent",
      assessment: { primary: "observed", observable: true },
    });
    const surface = makeSurface({ capabilities: { a: {} } });

    const declaredOnly = evaluateServerFeatures(
      [parent, declaredChild, observedChild],
      connected({}, surface)
    );
    expect(declaredOnly.assessments["test.parent"]).toMatchObject({
      state: "supported",
      sources: ["declared"],
    });

    const seen = evaluateServerFeatures(
      [parent, declaredChild, observedChild],
      connected(
        {
          observations: [
            {
              featureId: "test.parent.b",
              count: 1,
              firstSeenAt: 1,
              lastSeenAt: 2,
              lastSource: "rpc",
            },
          ],
        },
        surface
      )
    );
    expect(seen.assessments["test.parent"]).toMatchObject({
      state: "supported",
      sources: ["observed", "declared"],
    });
  });

  it("hashes the capture context into the evaluation", () => {
    const result = evaluateServerFeatures([tools], connected());
    expect(result.contextHash).toMatch(/^ctx_[0-9a-f]{16}$/);
  });
});

describe("client-dependent features", () => {
  const appsTool = feature("test.apps", {
    family: "mcp-apps",
    assessment: {
      primary: "declared",
      requiresClientExtension: "io.modelcontextprotocol/ui",
      declared: () => ({ kind: "absent", basis: ["tools", "toolMeta"] }),
    },
  });

  it("never offers Could add when the client lacks the extension", () => {
    const result = evaluateServerFeatures(
      [appsTool],
      connected({
        context: { transport: "streamable-http", protocolVersion: "2025-11-25", clientExtensions: [] },
      }),
    );
    expect(result.assessments["test.apps"].state).toBe("needs-newer");
  });

  it("offers Could add when the client advertised the extension", () => {
    const result = evaluateServerFeatures(
      [appsTool],
      connected({
        context: {
          transport: "streamable-http",
          protocolVersion: "2025-11-25",
          clientExtensions: ["io.modelcontextprotocol/ui"],
        },
      }),
    );
    expect(result.assessments["test.apps"].state).toBe("could-add");
  });

  it("does not guess when the client's extensions were not recorded", () => {
    const result = evaluateServerFeatures([appsTool], connected());
    expect(result.assessments["test.apps"]).toMatchObject({
      state: "not-checked",
      nextAction: "reconnect",
    });
  });
});
