/**
 * The redactor, applied to the shape it was NOT written for.
 *
 * `redactConformanceReportForSharing` was built for a conformance report:
 * suites of checks, each with `httpAttempts` and a `credentials` bag. A
 * readiness result is a different document — lanes, findings, coverage,
 * badges, an observation envelope — and it is now stored through the same
 * pass, so the question this file answers is whether the pass is still both
 * SAFE and NON-DESTRUCTIVE on that shape.
 *
 * It matters that the input here is hand-built rather than graded. No check
 * shipping today writes a credential into a finding, so a run against a live
 * fixture cannot produce the hazardous document — which is precisely the
 * argument for having the guarantee in place before the check that first
 * records a request exists. The fixture below is what that check's output
 * would look like.
 */

import { describe, expect, it } from "vitest";

import { redactConformanceReportForSharing } from "../src/conformance-redaction.js";

/** A readiness-shaped result whose findings carry hazardous evidence. */
function readinessResultWithSecrets() {
  return {
    status: "not-ready",
    summary: "One lane is not ready.",
    context: {
      target: "https://connector.example.com/mcp",
      authMode: "provided-token",
      capabilities: [],
      evidenceSources: ["protocol-conformance"],
    },
    lanes: [
      {
        lane: "runtime-compatibility",
        status: "not-ready",
        coverage: {
          lane: "runtime-compatibility",
          evaluated: 3,
          notEvaluated: 1,
          notApplicable: 0,
          missingInputs: ["toolListing"],
        },
      },
    ],
    findings: [
      {
        id: "claude.auth.prm-discoverable",
        title: "Protected Resource Metadata is discoverable",
        lane: "runtime-compatibility",
        class: "required",
        status: "violated",
        remediation: "Publish a PRM document at the well-known path.",
        provenance: "observed",
        intrusiveness: "passive",
        evaluatedAt: "2026-08-20T00:00:00.000Z",
        engineVersion: "1",
        details: {
          // The shapes a future check would plausibly record.
          authorization: "Bearer sk-live-should-not-survive",
          accessToken: "at-should-not-survive",
          registrationAccessToken: "rat-should-not-survive",
          requestUrl:
            "https://connector.example.com/callback?code=authcode-should-not-survive&state=ok",
          // Innocuous evidence that MUST survive: this is what the finding is
          // for, and a redactor that ate it would make the product useless.
          statusCode: 404,
          wwwAuthenticate: 'Bearer realm="example"',
        },
      },
    ],
    badges: [
      { id: "claude.badge.apps", title: "MCP Apps", state: "supported" },
    ],
    policySnapshotDate: "2026-08-19",
    engineVersion: "1",
    startedAt: "2026-08-20T00:00:00.000Z",
    durationMs: 1234,
  };
}

describe("redacting a directory-readiness result", () => {
  it("removes every credential-shaped value", () => {
    const redacted = redactConformanceReportForSharing(
      readinessResultWithSecrets(),
    );
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain("sk-live-should-not-survive");
    expect(serialized).not.toContain("at-should-not-survive");
    // Vendor-prefixed names the explicit key set cannot enumerate.
    expect(serialized).not.toContain("rat-should-not-survive");
    // A secret in a URL's query is not a key-shaped value, and is the case the
    // key-name layer alone would miss.
    expect(serialized).not.toContain("authcode-should-not-survive");
  });

  it("leaves the finding a submitter has to act on intact", () => {
    // The failure mode opposite to leaking: a redactor that flattens the
    // document turns a graded report into an unreadable one, and a reader who
    // cannot see WHY a lane failed has nothing to fix.
    const redacted = redactConformanceReportForSharing(
      readinessResultWithSecrets(),
    ) as ReturnType<typeof readinessResultWithSecrets>;

    expect(redacted.status).toBe("not-ready");
    expect(redacted.findings).toHaveLength(1);
    const finding = redacted.findings[0]!;
    expect(finding.id).toBe("claude.auth.prm-discoverable");
    expect(finding.class).toBe("required");
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toContain("PRM document");
    expect(finding.details.statusCode).toBe(404);
    // A KNOWN, ACCEPTED COST, pinned here so it is a decision rather than a
    // surprise. The redactor scrubs whatever follows a `Bearer ` scheme,
    // which is exactly right for an `Authorization` header — and a
    // `WWW-Authenticate` CHALLENGE starts with the same word, so its
    // `realm=` / `resource_metadata=` parameter name is scrubbed too:
    //
    //   'Bearer realm="example"'  ->  'Bearer [REDACTED]"example"'
    //
    // The parameter VALUE survives, so the pointer a submitter needs is still
    // readable, and nothing shipping today writes a challenge into `details`.
    // Teaching a shared security utility to recognise one header would mean
    // narrowing a rule that currently errs safe, which is its own review — not
    // a drive-by in a defense-in-depth change.
    expect(finding.details.wwwAuthenticate).toBe('Bearer [REDACTED]"example"');
    // Lane coverage is the honesty channel — it must survive verbatim.
    expect(redacted.lanes[0]!.coverage).toMatchObject({
      evaluated: 3,
      notEvaluated: 1,
      missingInputs: ["toolListing"],
    });
    expect(redacted.badges).toHaveLength(1);
  });

  it("is safe to run twice", () => {
    // The worker redacts on the way into storage; nothing stops a future
    // surface from redacting again on the way out, and a pass that is not
    // idempotent would corrupt the second time.
    const once = redactConformanceReportForSharing(
      readinessResultWithSecrets(),
    );
    const twice = redactConformanceReportForSharing(once);
    expect(twice).toEqual(once);
  });
});
