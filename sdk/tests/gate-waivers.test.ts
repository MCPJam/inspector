/**
 * E5 — the gate-waiver half of the Lane E charter, on the SDK side.
 *
 * The charter's words are "authorized actor, reason, expiry, affected
 * policy/run, visible CI/report status; no silent or permanent waiver." The
 * platform owns the authorization and the expiry cap. What this module owns is
 * the last clause, and it is the one a passing test suite can most easily
 * pretend to satisfy: a waiver that flips an exit code without naming itself
 * in the artifacts is a SILENT waiver, and every assertion below exists to
 * make that unbuildable rather than merely discouraged.
 */

import { describe, expect, it } from "vitest";
// Imported from the MODULES, not the package barrel: `../src/index.ts`
// re-exports a skills bundle that pulls a `.md` file through vite's import
// analysis, which fails to parse. Every sibling test in this directory does
// the same.
import {
  applyGateWaiver,
  formatGateReport,
  isGateWaiverInForce,
  type GateReport,
  type GateWaiver,
} from "../src/gates.js";
import { parseJUnitXmlArtifact } from "../src/artifact-parsers/index.js";
import {
  renderStructuredRunHtml,
  renderStructuredRunJson,
  renderStructuredRunJUnitXml,
  summarizeStructuredCases,
  type StructuredRunReport,
} from "../src/structured-reporting.js";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

function waiver(overrides: Partial<GateWaiver> = {}): GateWaiver {
  return {
    id: "wv_1",
    reason: "hotfix ships today; regression tracked in ENG-1",
    expiresAt: NOW + 24 * HOUR,
    createdAt: NOW - HOUR,
    createdBy: "usr_1",
    createdByEmail: "alice@example.com",
    policySnapshot: { minimumPassRate: 100 },
    ...overrides,
  };
}

function failedReport(): GateReport {
  return {
    outcome: "failed",
    scoreIntegrity: "valid",
    verdicts: [
      {
        gate: "minimumPassRate",
        status: "failed",
        message: "pass rate 0.500 over 10 iteration(s)",
        observed: 0.5,
        threshold: 1,
      },
    ],
  };
}

describe("applyGateWaiver — what may be waived", () => {
  it("turns a FAILED gate into its own `waived` outcome, never into `passed`", () => {
    const report = applyGateWaiver(failedReport(), waiver(), NOW);
    // The distinction has to survive: one line later, `passed` and `waived`
    // would be indistinguishable and no artifact could recover which happened.
    expect(report.outcome).toBe("waived");
    expect(report.outcome).not.toBe("passed");
    expect(report.waiver?.id).toBe("wv_1");
  });

  it("keeps the failing verdicts, so the report still says WHAT failed", () => {
    const report = applyGateWaiver(failedReport(), waiver(), NOW);
    expect(
      report.verdicts.some(
        (verdict) =>
          verdict.gate === "minimumPassRate" && verdict.status === "failed"
      )
    ).toBe(true);
    // ...and prepends a row naming the override, so the per-gate table shows
    // both the failure and the reason it was not fatal.
    expect(report.verdicts[0]).toMatchObject({
      gate: "waiver",
      status: "waived",
    });
  });

  it("does NOT waive `incomplete` — nothing was established to override", () => {
    // The fail-open case this rule exists to refuse: a waiver granted because
    // the evals regressed is not consent to ship on a cancelled run or a
    // flaked network call.
    const incomplete: GateReport = {
      outcome: "incomplete",
      scoreIntegrity: "unknown",
      verdicts: [
        { gate: "run", status: "non_gateable", message: "run is cancelled" },
      ],
    };
    const report = applyGateWaiver(incomplete, waiver(), NOW);
    expect(report.outcome).toBe("incomplete");
    // Still ATTACHED, so the artifact names it even though it decided nothing.
    expect(report.waiver?.id).toBe("wv_1");
  });

  it("does NOT waive `usage_error` — a broken policy is not an eval verdict", () => {
    const usage: GateReport = {
      outcome: "usage_error",
      scoreIntegrity: "valid",
      verdicts: [
        {
          gate: "minimumScorerPassRate:x",
          status: "usage_error",
          message: "unknown scorer",
        },
      ],
    };
    expect(applyGateWaiver(usage, waiver(), NOW).outcome).toBe("usage_error");
  });

  it("leaves `passed` alone but still records the waiver", () => {
    const passed: GateReport = {
      outcome: "passed",
      scoreIntegrity: "valid",
      verdicts: [{ gate: "minimumPassRate", status: "passed", message: "ok" }],
    };
    const report = applyGateWaiver(passed, waiver(), NOW);
    expect(report.outcome).toBe("passed");
    expect(report.waiver?.id).toBe("wv_1");
  });
});

describe("applyGateWaiver — no PERMANENT waiver", () => {
  it("ignores an EXPIRED waiver, so a lapsed one cannot keep a gate green", () => {
    // The property the platform cannot verify for itself: a Convex query is
    // cached against the documents it read, and time is not a document, so an
    // expired waiver can still be SERVED as active. Deciding it here is what
    // keeps a time-boxed waiver from silently becoming permanent.
    const expired = waiver({ expiresAt: NOW - 1 });
    expect(isGateWaiverInForce(expired, NOW)).toBe(false);
    const report = applyGateWaiver(failedReport(), expired, NOW);
    expect(report.outcome).toBe("failed");
    expect(report.waiver).toBeUndefined();
  });

  it("treats the expiry instant itself as lapsed", () => {
    expect(isGateWaiverInForce(waiver({ expiresAt: NOW }), NOW)).toBe(false);
    expect(isGateWaiverInForce(waiver({ expiresAt: NOW + 1 }), NOW)).toBe(true);
  });

  it("is a no-op when there is no waiver at all", () => {
    expect(applyGateWaiver(failedReport(), null, NOW).outcome).toBe("failed");
    expect(applyGateWaiver(failedReport(), undefined, NOW).outcome).toBe(
      "failed"
    );
  });
});

describe("formatGateReport — the human artifact names who, why and until", () => {
  it("says WAIVED, names the granter, the reason and the expiry", () => {
    const text = formatGateReport(
      applyGateWaiver(failedReport(), waiver(), NOW)
    );
    expect(text).toContain("Gate: WAIVED");
    expect(text).toContain("alice@example.com");
    expect(text).toContain("hotfix ships today; regression tracked in ENG-1");
    expect(text).toContain(new Date(NOW + 24 * HOUR).toISOString());
    // And refuses to read as a clean run.
    expect(text).toContain("not a clean pass");
    expect(text).not.toContain("Gate: PASSED");
  });

  it("falls back to the user id when the email cannot be resolved", () => {
    // A deleted user must not make a waiver look authorless.
    const text = formatGateReport(
      applyGateWaiver(failedReport(), waiver({ createdByEmail: null }), NOW)
    );
    expect(text).toContain("usr_1");
  });

  it("marks a waiver that changed nothing as exactly that", () => {
    const passed: GateReport = {
      outcome: "passed",
      scoreIntegrity: "valid",
      verdicts: [],
    };
    const text = formatGateReport(applyGateWaiver(passed, waiver(), NOW));
    expect(text).toContain("did not change this outcome");
  });
});

// ── The structured artifacts ────────────────────────────────────────────────

function waivedRunReport(): StructuredRunReport {
  const cases = [
    {
      id: "gate",
      title: "Eval gate (WAIVED)",
      category: "gate",
      passed: true,
      classification: "informational" as const,
      error: "pass rate 0.500 over 10 iteration(s)",
      waiver: {
        id: "wv_1",
        reason: "hotfix ships today; regression tracked in ENG-1",
        expiresAt: NOW + 24 * HOUR,
        createdAt: NOW - HOUR,
        createdBy: "usr_1",
        createdByEmail: "alice@example.com",
        policySnapshot: { minimumPassRate: 100 },
      },
    },
  ];
  return {
    schemaVersion: 1,
    kind: "eval-run",
    passed: false,
    verdict: "waived",
    summary: summarizeStructuredCases(cases),
    cases,
    durationMs: 1500,
    metadata: {},
  };
}

describe("JSON reporter", () => {
  it("carries the waiver, unredacted, on the gate case", () => {
    const json = renderStructuredRunJson(waivedRunReport());
    const gate = json.cases.find((entry) => entry.id === "gate");
    expect(gate?.waiver).toMatchObject({
      createdByEmail: "alice@example.com",
      reason: "hotfix ships today; regression tracked in ENG-1",
      expiresAt: NOW + 24 * HOUR,
    });
    expect(json.verdict).toBe("waived");
  });
});

describe("JUnit reporter", () => {
  const xml = renderStructuredRunJUnitXml(waivedRunReport());

  it("marks the waived gate `skipped`, not a bare passing testcase", () => {
    // `<skipped>` is JUnit's own third state: it does not fail the build (which
    // is what the waiver was granted for) and it does not render as a clean
    // green row (which would be the silent waiver the charter forbids).
    expect(xml).toContain("<skipped message=");
    expect(xml).not.toMatch(/<testcase name="Eval gate \(WAIVED\)"[^>]*\/>/);
  });

  it("names who, why and until when in the message a CI UI displays", () => {
    expect(xml).toContain("Gate WAIVED by alice@example.com");
    expect(xml).toContain("hotfix ships today");
    expect(xml).toContain(new Date(NOW + 24 * HOUR).toISOString());
  });

  it("declares the skip on the suite, and does not fail the suite", () => {
    expect(xml).toContain('failures="0"');
    expect(xml).toContain('skipped="1"');
  });

  it("round-trips through this repo's own JUnit parser as NOT passed", () => {
    // The `<skipped>` element is hand-written into a template string, so a
    // string-contains assertion would still pass on markup no parser accepts.
    // Reading it back through `parseJUnitXmlArtifact` proves it is real — and
    // proves the classification a CI system actually derives: the parser marks
    // a `<skipped>` case `passed: false`, so a waived gate does not read as a
    // clean pass to a machine either.
    const [gate] = parseJUnitXmlArtifact(xml);
    expect(gate).toBeDefined();
    expect(gate!.passed).toBe(false);
    expect(gate!.caseTitle).toContain("Eval gate (WAIVED)");
    // The parser lifts the skip message, so who/why/until reaches a consumer
    // that never reads the raw XML.
    expect(gate!.error).toContain("Gate WAIVED by alice@example.com");
  });

  it("stays well-formed XML with a hostile reason in the skip message", () => {
    // `reason` is caller-authored and lands inside an XML attribute.
    const report = waivedRunReport();
    report.cases[0]!.waiver!.reason = 'he said "ship it" & <hurry> \u0000';
    const hostile = renderStructuredRunJUnitXml(report);
    expect(hostile).toContain("&quot;ship it&quot;");
    expect(hostile).toContain("&amp;");
    expect(hostile).toContain("&lt;hurry&gt;");
    // A raw NUL cannot appear in XML 1.0 even as a character reference.
    expect(hostile).not.toMatch(/\u0000/);
    expect(parseJUnitXmlArtifact(hostile)).toHaveLength(1);
  });

  it("omits `skipped` entirely when nothing was waived", () => {
    // Not `skipped="0"`: this XML is asserted as a literal by CI consumers,
    // and an attribute on every report ever rendered would be a wire change
    // that says nothing.
    const clean = renderStructuredRunJUnitXml({
      ...waivedRunReport(),
      verdict: "failed",
      cases: [
        { id: "gate", title: "Eval gate", category: "gate", passed: false },
      ],
    });
    expect(clean).not.toContain("skipped=");
  });
});

describe("HTML reporter", () => {
  const html = renderStructuredRunHtml(waivedRunReport());

  it("paints WAIVED as its own state — neither the green of a pass nor red", () => {
    // Asserted on the rendered ELEMENT, not the bare class name: every badge
    // class appears in the inline stylesheet on every page, so a substring
    // check against `badge-pass` would pass vacuously here and fail
    // vacuously above.
    expect(html).toContain('class="badge badge-waived"');
    expect(html).not.toContain('class="badge badge-pass"');
    expect(html).not.toContain('class="badge badge-fail"');
  });

  it("gives the waiver its own section naming who, why and until when", () => {
    expect(html).toContain("Waived (1)");
    expect(html).toContain("alice@example.com");
    expect(html).toContain("hotfix ships today");
    expect(html).toContain(new Date(NOW + 24 * HOUR).toISOString());
  });

  it("says what was overridden when the run recorded a policy", () => {
    expect(html).toContain("minimum pass rate 100");
  });

  it("escapes a hostile reason rather than rendering it as markup", () => {
    // `reason` is caller-authored free text and lands in a page a human opens
    // from a CI artifact.
    const report = waivedRunReport();
    report.cases[0]!.waiver!.reason = '<img src=x onerror="alert(1)">';
    const rendered = renderStructuredRunHtml(report);
    expect(rendered).not.toContain("<img src=x");
    expect(rendered).toContain("&lt;img src=x");
  });
});
