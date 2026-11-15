/**
 * A run's verdict under a submission's gate: the directory's blocking set by
 * default, one check moved to warn only or made to fail the run, and the
 * checks a run's path can never evaluate kept out of the default gate with
 * the reason. The real runs below show `ready` is reachable on the hosted
 * path once the answers are complete and confirmed.
 */

import type { Tool } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import {
  gradeClaudeReadiness,
  type ClaudeReadinessInput,
} from "../../src/claude-readiness/runner.js";
import {
  CLAUDE_CONNECTOR_FLOW as FLOW,
  directoryVerdict,
  isDispositiveDirectoryFinding,
  placeDirectoryResults,
  type DirectoryReadinessFinding,
} from "../../src/directory-readiness/index.js";
import {
  answer,
  confirmedAnswers,
} from "../support/claude-connector-answers.js";

const SERVER = "https://mcp.example.com/mcp";
const HOSTED = { path: "hosted" } as const;
const LISTING = "claude.submission.listing-fields";
const INTRUSIVE = [
  "claude.auth.insufficient-scope-challenge-shape",
  "claude.intrusive.dynamic-registration",
  "claude.intrusive.refresh-rotation",
  "claude.intrusive.step-up-challenge",
];
const RFC8707 = "claude.auth.rfc8707-resource-canonical";
/** Off until a threshold is set, so no run gathers their answers. */
const DECISIONS = [
  "both.decision.annotation-matches-behaviour",
  "claude.decision.cross-tool-direction",
];

function finding(
  id: string,
  rest: Partial<DirectoryReadinessFinding> = {}
): DirectoryReadinessFinding {
  return {
    id,
    title: id,
    lane: "directory-policy",
    class: "required",
    status: "satisfied",
    source: {},
    provenance: "static",
    intrusiveness: "passive",
    evaluatedAt: "2026-08-19T00:00:01.000Z",
    engineVersion: "1",
    ...rest,
  };
}

/** An OAuth server the run saw in full, with a confirmed submission. */
function run(overrides: Partial<ClaudeReadinessInput> = {}) {
  return gradeClaudeReadiness({
    enteredUrl: SERVER,
    authMode: "headless",
    capabilities: ["dns"],
    startedAt: "2026-08-19T00:00:00.000Z",
    evaluatedAt: "2026-08-19T00:00:01.000Z",
    durationMs: 1000,
    endpoint: {
      enteredUrl: SERVER,
      redirectChain: [{ url: SERVER, status: 200 }],
    },
    auth: {
      enteredUrl: SERVER,
      unauthenticated: {
        status: 401,
        wwwAuthenticate:
          'Bearer resource_metadata="https://mcp.example.com/prm"',
        representsProtectedOperation: true,
        servedWithoutCredentials: false,
      },
      prm: {
        discoveredVia: "www-authenticate",
        document: {
          resource: SERVER,
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
    apps: { enteredUrl: SERVER, appsSuiteRan: true, tools: [] },
    tools: [
      {
        name: "list_orders",
        title: "List orders",
        annotations: { title: "List orders", readOnlyHint: true },
        inputSchema: { type: "object", properties: {} },
      } as Tool,
    ],
    submissionAnswers: confirmedAnswers(),
    ...overrides,
  });
}

describe("the default gate", () => {
  it("fails the run on a violated requirement or runtime blocker", () => {
    for (const blocking of ["required", "runtime-blocker"] as const) {
      const result = directoryVerdict(
        [finding("a"), finding("b", { class: blocking, status: "violated" })],
        HOSTED
      );
      expect(result).toMatchObject({ verdict: "not-ready", failing: ["b"] });
    }
  });

  it("lets a violation that is not a requirement through", () => {
    const result = directoryVerdict(
      [
        finding("a"),
        finding("b", { class: "recommended", status: "violated" }),
        finding("c", { class: "manual-review", status: "violated" }),
        finding("d", { class: "heuristic", status: "informational" }),
      ],
      HOSTED
    );
    expect(result).toMatchObject({ verdict: "ready", failing: [] });
  });

  it("is incomplete while a requirement has no verdict, and names it", () => {
    const result = directoryVerdict(
      [
        finding("a"),
        finding("b", { status: "not-evaluated", notEvaluatedReason: "x" }),
        finding("c", { status: "not-applicable" }),
      ],
      HOSTED
    );
    expect(result).toMatchObject({
      verdict: "incomplete",
      undetermined: ["b"],
    });
  });

  it("puts a violation ahead of a gap", () => {
    const result = directoryVerdict(
      [
        finding("a", { status: "violated" }),
        finding("b", { status: "not-evaluated" }),
      ],
      HOSTED
    );
    expect(result.verdict).toBe("not-ready");
  });

  it("decides nothing from a run that gated nothing", () => {
    expect(directoryVerdict([], HOSTED).verdict).toBe("incomplete");
  });
});

describe("a submission's gate", () => {
  it("moves a Listing check to warn only: it still fails, the verdict ignores it, and the gate is named", () => {
    const findings = run({
      submissionAnswers: confirmedAnswers([
        answer("listing.oneLiner", "x".repeat(201)),
      ]),
    }).findings;
    expect(findings.find((f) => f.id === LISTING)?.status).toBe("violated");
    expect(directoryVerdict(findings, HOSTED)).toMatchObject({
      verdict: "not-ready",
      failing: [LISTING],
    });
    expect(
      directoryVerdict(findings, {
        ...HOSTED,
        checkGate: { warnOnly: [LISTING] },
      })
    ).toMatchObject({
      verdict: "ready",
      failing: [],
      gate: { failOn: [], warnOnly: [LISTING] },
    });
  });

  it("counts a blocking check the run left out as unknown, unless warn only", () => {
    const findings = run({
      submissionAnswers: confirmedAnswers([
        answer("listing.oneLiner", "x".repeat(201)),
      ]),
    }).findings;
    const blocking = findings
      .filter(isDispositiveDirectoryFinding)
      .map((entry) => entry.id);
    expect(blocking).toContain(LISTING);
    const withoutListing = findings.filter((entry) => entry.id !== LISTING);
    expect(
      directoryVerdict(withoutListing, { ...HOSTED, blocking })
    ).toMatchObject({ verdict: "incomplete", undetermined: [LISTING] });
    expect(
      directoryVerdict(withoutListing, {
        ...HOSTED,
        blocking,
        checkGate: { warnOnly: [LISTING] },
      })
    ).toMatchObject({ verdict: "ready", undetermined: [] });
  });

  it("fails the run on any check failOn names, even one that is not a requirement", () => {
    const result = directoryVerdict(
      [finding("a"), finding("b", { class: "heuristic", status: "violated" })],
      { ...HOSTED, checkGate: { failOn: ["b"] } }
    );
    expect(result).toMatchObject({ verdict: "not-ready", failing: ["b"] });
  });

  it("lets failOn win over warnOnly, and says so in the gate", () => {
    const result = directoryVerdict([finding("a", { status: "violated" })], {
      ...HOSTED,
      checkGate: { failOn: ["a"], warnOnly: ["a", "b"] },
    });
    expect(result).toMatchObject({
      verdict: "not-ready",
      gate: { failOn: ["a"], warnOnly: ["b"] },
    });
  });

  it("counts a check failOn names that the run never reported as unknown", () => {
    const result = directoryVerdict([finding("a")], {
      ...HOSTED,
      checkGate: { failOn: ["claude.not-a-check"] },
    });
    expect(result).toMatchObject({
      verdict: "incomplete",
      undetermined: ["claude.not-a-check"],
    });
  });
});

describe("checks the path cannot evaluate", () => {
  it("reaches ready on the hosted path once the answers are complete and confirmed", () => {
    const result = run();
    // The lane rollup current callers read is unchanged.
    expect(result.status).toBe("incomplete");
    const verdict = directoryVerdict(result.findings, HOSTED);
    expect(verdict).toMatchObject({
      verdict: "ready",
      failing: [],
      undetermined: [],
      notCheckedOnPath: [...INTRUSIVE, RFC8707, ...DECISIONS].sort(),
    });
    for (const id of DECISIONS) {
      expect(verdict.notCheckedReasons[id], id).toMatch(/scan is off/);
    }
    for (const id of INTRUSIVE) {
      expect(verdict.notCheckedReasons[id], id).toBe(
        "hosted runs never make probes that change the server, such as registering an OAuth client or spending a refresh token"
      );
    }
    expect(verdict.notCheckedReasons[RFC8707]).toBe(
      "it reads the requests of a completed OAuth sign-in, and no run records those yet"
    );
  });

  it("keeps the intrusive checks in the gate on the CLI path", () => {
    const verdict = directoryVerdict(run().findings, { path: "cli" });
    expect(verdict).toMatchObject({
      verdict: "incomplete",
      undetermined: INTRUSIVE,
      notCheckedOnPath: [RFC8707, ...DECISIONS].sort(),
    });
  });

  it("puts one back in the gate when failOn names it", () => {
    const verdict = directoryVerdict(run().findings, {
      ...HOSTED,
      checkGate: { failOn: [RFC8707] },
    });
    expect(verdict).toMatchObject({
      verdict: "incomplete",
      undetermined: [RFC8707],
    });
    expect(verdict.notCheckedOnPath).toContain(RFC8707);
  });

  it("leaves a check that reached a verdict in the gate", () => {
    const verdict = directoryVerdict(
      [
        finding(RFC8707, {
          status: "violated",
          requiresCapabilities: ["interactive-oauth"],
        }),
      ],
      HOSTED
    );
    expect(verdict).toMatchObject({
      verdict: "not-ready",
      notCheckedOnPath: [],
    });
  });
});

describe("placed findings", () => {
  it("count a stale or blocked gated result as unknown, not as its old verdict", () => {
    const graded = confirmedAnswers();
    const findings = run({ submissionAnswers: graded }).findings;
    const placed = (answers = graded) =>
      placeDirectoryResults({
        flow: FLOW,
        answers,
        findings,
        gradedAnswers: graded,
      }).flatMap((step) => step.findings);
    expect(directoryVerdict(placed(), HOSTED).verdict).toBe("ready");
    const stale = directoryVerdict(
      placed(confirmedAnswers([answer("listing.oneLiner", "Track orders")])),
      HOSTED
    );
    expect(stale).toMatchObject({
      verdict: "incomplete",
      undetermined: [LISTING],
    });
  });
});
