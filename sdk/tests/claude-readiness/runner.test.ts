/**
 * The composite run: five lanes, one rollup, and the rules that stop the soft
 * lanes from deciding anything.
 */

import type { Tool } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import {
  CLAUDE_GATED_INPUTS,
  gradeClaudeReadiness,
  type ClaudeReadinessInput,
} from "../../src/claude-readiness/runner.js";
import { toConformanceReport } from "../../src/conformance-reporting.js";

const URL_UNDER_TEST = "https://mcp.example.com/mcp";

function input(overrides: Partial<ClaudeReadinessInput> = {}): ClaudeReadinessInput {
  return {
    enteredUrl: URL_UNDER_TEST,
    authMode: "headless",
    capabilities: ["dns"],
    startedAt: "2026-08-19T00:00:00.000Z",
    evaluatedAt: "2026-08-19T00:00:01.000Z",
    durationMs: 1000,
    endpoint: {
      enteredUrl: URL_UNDER_TEST,
      // A REAL one-hop chain. An empty array means the run never reached the
      // endpoint at all, which is a coverage gap rather than a clean result.
      redirectChain: [{ url: URL_UNDER_TEST, status: 200 }],
    },
    auth: {
      enteredUrl: URL_UNDER_TEST,
      unauthenticated: {
        status: 401,
        wwwAuthenticate: 'Bearer resource_metadata="https://mcp.example.com/prm"',
        representsProtectedOperation: true,
        servedWithoutCredentials: false,
      },
      prm: {
        discoveredVia: "www-authenticate",
        document: {
          resource: URL_UNDER_TEST,
          authorization_servers: ["https://auth.example.com"],
        },
      },
      firstAuthorizationServer: {
        issuer: "https://auth.example.com",
        reachable: true,
        document: {
          registration_endpoint: "https://auth.example.com/register",
          code_challenge_methods_supported: ["S256"],
          response_types_supported: ["code"],
        },
      },
    },
    apps: { enteredUrl: URL_UNDER_TEST, appsSuiteRan: true, tools: [] },
    tools: [
      {
        name: "list_orders",
        title: "List orders",
        annotations: { readOnlyHint: true },
        inputSchema: { type: "object", properties: {} },
        // `as Tool`, not `as never`: the bottom type is assignable to
        // everything, so `as never` would stop the compiler checking this
        // fixture against `Tool` at all.
      } as Tool,
    ],
    evidenceSources: ["protocol-conformance", "apps-conformance"],
    ...overrides,
  };
}

/**
 * A run with everything: an authorization was completed, so the resource
 * parameter is observable, and the intrusive probes were armed and ran.
 *
 * This is what `ready` actually costs. A headless run cannot reach it, and the
 * tests below insist on that rather than papering over it — reporting `ready`
 * for requirements a run could not evaluate is the single most damaging thing
 * this product could do.
 */
function fullyCapable(): ClaudeReadinessInput {
  const base = input();
  return {
    ...base,
    authMode: "interactive",
    capabilities: ["dns", "interactive-oauth", "intrusive-probes"],
    auth: {
      ...base.auth,
      resourceIndicatorsSent: {
        authorize: URL_UNDER_TEST,
        token: URL_UNDER_TEST,
      },
    },
    intrusive: {
      enabled: true,
      grantOrigin: "dedicated-test-account",
      testCredentials: { clientId: "test", refreshToken: "rt" },
      protectedToolName: "list_orders",
      expectedScopes: ["orders:read"],
    },
    intrusiveObservations: {
      registration: { attempted: true, status: 201, cleanedUp: true },
      refresh: {
        attempted: true,
        rotated: true,
        replayStatus: 400,
        replayError: "invalid_grant",
      },
      stepUp: {
        attempted: true,
        toolName: "list_orders",
        status: 403,
        wwwAuthenticate: 'Bearer error="insufficient_scope"',
      },
    },
  };
}

describe("the rollup", () => {
  it("reports ready only when everything applicable was actually evaluated", () => {
    const result = gradeClaudeReadiness(fullyCapable());
    expect(result.status).toBe("ready");
    expect(result.summary).toMatch(/satisfied/);
  });

  it("is incomplete for a healthy server graded headlessly, and says why", () => {
    // Nothing is wrong with this connector. The run simply could not complete
    // an authorization or run a side-effecting probe, and `incomplete` is the
    // honest word for that.
    const result = gradeClaudeReadiness(input());
    expect(result.status).toBe("incomplete");
    expect(
      result.findings.filter(
        (finding) =>
          finding.status === "violated" &&
          (finding.class === "required" || finding.class === "runtime-blocker"),
      ),
    ).toEqual([]);
    const unevaluated = result.findings.filter(
      (finding) =>
        finding.lane === "runtime-compatibility" &&
        finding.status === "not-evaluated",
    );
    expect(unevaluated.map((finding) => finding.id)).toEqual(
      expect.arrayContaining([
        "claude.auth.rfc8707-resource-canonical",
        "claude.intrusive.dynamic-registration",
      ]),
    );
  });

  it("cannot be moved by the optional or insight lanes", () => {
    // A heuristic that fires and a badge that is missing are both present in
    // this run; neither may change the verdict.
    const result = gradeClaudeReadiness({
      ...fullyCapable(),
      apps: {
        enteredUrl: URL_UNDER_TEST,
        appsSuiteRan: true,
        tools: [
          {
            name: "widget",
            resourceUri: "ui://w",
            hasNestedField: true,
            hasLegacyField: false,
          },
        ],
        resources: [
          {
            uri: "ui://w",
            mimeType: "text/html;profile=mcp-app",
            html: "<html><body><button>x</button></body></html>",
          },
        ],
      },
    });
    expect(
      result.findings.some(
        (finding) => finding.class === "heuristic" && finding.status === "violated",
      ),
    ).toBe(true);
    expect(result.status).toBe("ready");
  });

  it("is not-ready on a runtime blocker", () => {
    const result = gradeClaudeReadiness(
      input({ endpoint: { enteredUrl: "http://mcp.example.com/mcp" } }),
    );
    expect(result.status).toBe("not-ready");
    expect(result.summary).toMatch(/runtime-compatibility/);
  });

  it("is incomplete when the policy lane never saw the tool listing", () => {
    const result = gradeClaudeReadiness({ ...fullyCapable(), tools: undefined });
    const policy = result.lanes.find((lane) => lane.lane === "directory-policy")!;
    expect(policy.status).toBe("incomplete");
    expect(result.status).toBe("incomplete");
  });

  it("stays ready when the server genuinely has no tools to grade", () => {
    // Inapplicable is not a gap: there is nothing here that could violate a
    // tool requirement.
    const result = gradeClaudeReadiness({ ...fullyCapable(), tools: [] });
    expect(
      result.lanes.find((lane) => lane.lane === "directory-policy")!.status,
    ).toBe("ready");
  });
});

describe("coverage and context", () => {
  it("names submissionProfile as the input the artifacts lane is missing", () => {
    const artifacts = gradeClaudeReadiness(input()).lanes.find(
      (lane) => lane.lane === "submission-artifacts",
    )!;
    expect(artifacts.status).toBe("incomplete");
    expect(artifacts.coverage.missingInputs).toContain("submissionProfile");
  });

  it("records what the runner could actually do", () => {
    // Two surfaces grading the same target agree only on their shared
    // capability subset; recording this is what makes a gap legible instead of
    // looking like a disagreement.
    const result = gradeClaudeReadiness(
      input({ capabilities: ["browser", "dns", "interactive-oauth"] }),
    );
    expect(result.context.capabilities).toEqual([
      "browser",
      "dns",
      "interactive-oauth",
    ]);
    expect(result.context.authMode).toBe("headless");
    expect(result.context.evidenceSources).toEqual([
      "apps-conformance",
      "protocol-conformance",
    ]);
  });

  it("will not let a check outrun the capabilities it declared", () => {
    // `requiresCapabilities` was documented as an invariant and enforced
    // nowhere, so it held only for as long as every check author remembered
    // it. A check that forgets does not fail loudly — it publishes a verdict
    // it had no evidence for. Asserted over EVERY declaring finding rather
    // than one known id, so a check added later is covered by this test
    // without anyone remembering to extend it.
    const result = gradeClaudeReadiness(input({ capabilities: ["dns"] }));
    const held = new Set(result.context.capabilities);
    // A VERDICT is what the gate is about. `not-applicable` says the rule does
    // not apply to this submission and `informational` carries no verdict at
    // all, so neither is a claim a missing capability could have supported —
    // and rewriting them would put "nobody checked" in a report where "there
    // is nothing to check" is the truth.
    const settled = new Set([
      "not-evaluated",
      "not-applicable",
      "informational",
    ]);
    const overreaching = result.findings.filter(
      (finding) =>
        (finding.requiresCapabilities ?? []).some(
          (capability) => !held.has(capability),
        ) && !settled.has(finding.status),
    );
    expect(overreaching).toEqual([]);
    // And the gate is reached at all — a run where nothing declares a missing
    // capability would pass the assertion above vacuously.
    expect(
      result.findings.some((finding) =>
        (finding.requiresCapabilities ?? []).some(
          (capability) => !held.has(capability),
        ),
      ),
    ).toBe(true);
  });

  it("never upgrades a finding on the strength of a capability", () => {
    // The gate is one-directional. Holding a capability cannot turn an
    // unevaluated check into a pass.
    const result = gradeClaudeReadiness(
      input({ capabilities: ["browser", "dns", "interactive-oauth"] }),
    );
    const gated = result.findings.filter((f) =>
      (f.requiresCapabilities ?? []).length > 0,
    );
    expect(gated.length).toBeGreaterThan(0);
    for (const finding of gated) {
      expect(finding.status).not.toBe("satisfied");
    }
  });

  it("stamps one evaluatedAt across every finding", () => {
    const result = gradeClaudeReadiness(input());
    const moments = new Set(result.findings.map((finding) => finding.evaluatedAt));
    expect([...moments]).toEqual(["2026-08-19T00:00:01.000Z"]);
  });

  it("carries the policy snapshot date the corpus was pinned at", () => {
    expect(gradeClaudeReadiness(input()).policySnapshotDate).toBe("2026-08-19");
  });
});

describe("the submission profile flows into the auth findings", () => {
  it("lets a declared preregistered client reclassify the acquisition path", () => {
    const withoutRegistration = input({
      auth: {
        ...input().auth,
        firstAuthorizationServer: {
          issuer: "https://auth.example.com",
          reachable: true,
          document: {
            code_challenge_methods_supported: ["S256"],
            response_types_supported: ["code"],
          },
        },
      },
    });

    const undeclared = gradeClaudeReadiness(withoutRegistration);
    expect(
      undeclared.findings.find(
        (f) => f.id === "claude.auth.client-acquisition-path",
      )?.status,
    ).toBe("violated");

    const declared = gradeClaudeReadiness({
      ...withoutRegistration,
      submissionProfile: {
        name: "Acme",
        tagline: "Acme orders",
        description: "d",
        categories: ["Productivity"],
        slug: "acme",
        documentationUrl: "https://acme.example/docs",
        privacyPolicyUrl: "https://acme.example/privacy",
        supportUrl: "https://acme.example/support",
        iconUrl: "https://acme.example/icon.png",
        declaredAuthMode: "oauth-preregistered",
        dataHandling: ["no-user-data"],
        screenshots: [1, 2, 3].map((n) => ({
          url: `https://acme.example/${n}.png`,
          mimeType: "image/png",
          widthPx: 1200,
          heightPx: 800,
          prompt: `p${n}`,
        })),
        attestations: {
          ownsOrIsAuthorizedForService: true,
          accurateDataHandlingDisclosure: true,
          compliesWithUsagePolicies: true,
          noProhibitedContent: true,
          maintainsSecurityPractices: true,
          respondsToSecurityReports: true,
          keepsListingAccurate: true,
        },
      },
    });
    expect(
      declared.findings.find((f) => f.id === "claude.auth.client-acquisition-path")
        ?.status,
    ).toBe("satisfied");
  });

  it("turns a malformed profile into findings rather than silence", () => {
    const result = gradeClaudeReadiness(
      input({ submissionProfile: { name: "only a name" } }),
    );
    const artifacts = result.findings.filter(
      (finding) => finding.lane === "submission-artifacts",
    );
    expect(artifacts.every((f) => f.status === "not-evaluated")).toBe(true);
    expect(artifacts[0].notEvaluatedReason).toMatch(/did not validate/);
  });
});

describe("intrusive mode inside a run", () => {
  it("stays off by default and says so on every intrusive finding", () => {
    const result = gradeClaudeReadiness(input());
    const intrusive = result.findings.filter(
      (finding) => finding.intrusiveness === "side-effecting",
    );
    expect(intrusive).toHaveLength(3);
    expect(intrusive.every((f) => f.status === "not-evaluated")).toBe(true);
  });

  it("refuses to arm when the run is holding somebody else's token", () => {
    // `provided-token` means the run holds credentials supplied for ordinary
    // operation. Spending them here would burn a session its owner did not
    // volunteer.
    const result = gradeClaudeReadiness(
      input({
        authMode: "provided-token",
        intrusive: { enabled: true, grantOrigin: "self-acquired" },
      }),
    );
    const finding = result.findings.find(
      (f) => f.id === "claude.intrusive.refresh-rotation",
    )!;
    expect(finding.status).toBe("not-evaluated");
    expect(finding.notEvaluatedReason).toMatch(/borrowed grant/);
  });
});

describe("it renders through the shared report adapter", () => {
  it("produces a readiness report with no conformance score", () => {
    const report = toConformanceReport(gradeClaudeReadiness(input()));
    expect(report.kind).toBe("claude-directory-readiness");
    expect(report.score).toBeUndefined();
    expect(report.groups.map((group) => group.id)).toEqual([
      "runtime-compatibility",
      "directory-policy",
      "optional-features",
      "submission-artifacts",
      "experience-insights",
    ]);
  });

  it("routes every finding to exactly one of cases or advisories", () => {
    // Both directions. Asserting only that advisory ids are absent from cases
    // would stay green if half the non-dispositive findings were dropped
    // entirely — which is the failure mode that matters.
    const result = gradeClaudeReadiness(input());
    const report = toConformanceReport(result);
    const caseIds = new Set(
      report.groups.flatMap((group) => group.cases.map((entry) => entry.id)),
    );
    const advisoryIds = new Set((report.advisories ?? []).map((a) => a.id));

    for (const finding of result.findings) {
      const dispositive =
        finding.class === "required" || finding.class === "runtime-blocker";
      expect(
        dispositive ? caseIds.has(finding.id) : advisoryIds.has(finding.id),
      ).toBe(true);
      expect(
        dispositive ? advisoryIds.has(finding.id) : caseIds.has(finding.id),
      ).toBe(false);
    }
    expect(advisoryIds.size).toBeGreaterThan(0);
  });

  it("keeps a finding whose lane was not reported, rather than dropping it", () => {
    // `lanes` and `findings` are independent arrays, so nothing in the type
    // says every finding's lane is reported. A dropped VIOLATED requirement
    // would understate the run with no counter and no error.
    const result = gradeClaudeReadiness(input());
    const orphaned = {
      ...result.findings[0],
      id: "claude.test.orphan",
      lane: "experience-insights" as const,
    };
    const report = toConformanceReport({
      ...result,
      lanes: [],
      findings: [orphaned],
    });
    expect(report.advisories?.map((a) => a.id)).toContain("claude.test.orphan");
  });
});

describe("what an incomplete run tells the reader to do", () => {
  it("names the tool listing, not `intrusive`, when the run never connected", () => {
    // The reported failure: an OAuth connector the run could not authenticate
    // to came back `incomplete` with "Supply intrusive to close the gap",
    // because the tool checks named no input of their own and `intrusive` was
    // the only candidate left standing.
    const result = gradeClaudeReadiness(
      input({ tools: undefined, apps: { enteredUrl: URL_UNDER_TEST, appsSuiteRan: false } }),
    );

    expect(result.status).toBe("incomplete");
    expect(result.summary).toContain("toolListing");
    expect(result.summary).not.toMatch(/Supply[^.]*intrusive/);
  });

  it("never puts a gated input in the `Supply …` clause", () => {
    // The invariant, over every input the runner can name, rather than the one
    // string this bug happened to produce.
    for (const probe of [
      input(),
      input({ tools: undefined }),
      input({ apps: { enteredUrl: URL_UNDER_TEST, appsSuiteRan: false } }),
      input({ submissionProfile: undefined }),
    ]) {
      const summary = gradeClaudeReadiness(probe).summary;
      const supplyClause = /Supply ([^.]*)\./.exec(summary)?.[1] ?? "";
      for (const gated of CLAUDE_GATED_INPUTS) {
        expect(supplyClause).not.toContain(gated);
      }
    }
  });

  it("says a clean run's only gap needs opt-in, and asks for nothing", () => {
    // Notion's authenticated run: nothing failed, every lane the run could
    // reach was satisfied, and the only remaining gap was the intrusive trio.
    const base = fullyCapable();
    const result = gradeClaudeReadiness({
      ...base,
      capabilities: ["dns", "interactive-oauth"],
      intrusive: undefined,
      intrusiveObservations: undefined,
    });

    expect(result.status).toBe("incomplete");
    expect(result.summary).not.toContain("Supply");
    expect(result.summary).toContain("opt-in on a server you control");
  });
});
