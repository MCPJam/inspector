/**
 * Claude-specific MCP Apps checks.
 *
 * Four rev-2 corrections are pinned here, each one a place a reasonable
 * implementation gets it backwards:
 *
 *   - the MODERN `_meta.ui.resourceUri` alone is correct; only legacy-ONLY is
 *     a problem (an earlier reading warned whenever the legacy field was
 *     absent, which is exactly inverted);
 *   - a `text/html;profile=mcp-app` mismatch is a FAILURE, not a warning;
 *   - an OpenAI-only widget blocks only when the tool is app-only;
 *   - `ui.domain` is derived from the EXACT entered URL, so a trailing slash
 *     changes the answer.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  claudeAppContentDomain,
  claudeAppResourceEvidenceFrom,
  claudeAppToolEvidenceFrom,
  runClaudeAppsChecks,
  type ClaudeAppsEvidence,
} from "../../src/claude-readiness/checks/apps.js";
import { decideLaneStatus } from "../../src/claude-readiness/index.js";
import { CLAUDE_APP_DESIGN_BUDGETS } from "../../src/claude-readiness/profile.js";

const STAMP = { evaluatedAt: "2026-08-19T00:00:00.000Z" };
const URL_UNDER_TEST = "https://mcp.example.com/mcp";

function run(evidence: Partial<ClaudeAppsEvidence>) {
  return runClaudeAppsChecks(
    { enteredUrl: URL_UNDER_TEST, appsSuiteRan: true, ...evidence },
    STAMP,
  );
}

function byId(findings: ReturnType<typeof run>, id: string) {
  return findings.find((finding) => finding.id === id)!;
}

const MODERN_TOOL = {
  name: "show_order",
  resourceUri: "ui://order",
  hasNestedField: true,
  hasLegacyField: false,
  toolMeta: { ui: { resourceUri: "ui://order" } },
};

const GOOD_RESOURCE = {
  uri: "ui://order",
  mimeType: "text/html;profile=mcp-app",
};

describe("no apps evidence versus no apps", () => {
  it("reports not-evaluated when the apps suite never ran", () => {
    // "We have no result" is not "this server has no widgets".
    const findings = runClaudeAppsChecks(
      { enteredUrl: URL_UNDER_TEST, appsSuiteRan: false },
      STAMP,
    );
    expect(findings.every((f) => f.status === "not-evaluated")).toBe(true);
  });

  it("reports not-applicable when the suite ran and found no widgets", () => {
    const findings = run({ tools: [] });
    expect(findings.every((f) => f.status === "not-applicable")).toBe(true);
  });

  it("accounts for every check on both early returns, design lints included", () => {
    // The early returns used to enumerate the checks by hand and omit the
    // eight design lints, so a run with no apps evidence quietly produced
    // fewer findings than the catalog advertises. A missing finding is worse
    // than a `not-evaluated` one: the reader has to notice the absence.
    const everyId = new Set(
      runClaudeAppsChecks(
        {
          enteredUrl: URL_UNDER_TEST,
          appsSuiteRan: true,
          tools: [MODERN_TOOL],
          resources: [GOOD_RESOURCE],
        },
        STAMP,
      ).map((finding) => finding.id),
    );

    for (const evidence of [
      { enteredUrl: URL_UNDER_TEST, appsSuiteRan: false },
      { enteredUrl: URL_UNDER_TEST, appsSuiteRan: true, tools: [] },
    ]) {
      const reported = new Set(
        runClaudeAppsChecks(evidence, STAMP).map((finding) => finding.id),
      );
      expect(reported).toEqual(everyId);
    }
  });
});

describe("resourceUri modernity", () => {
  it("passes a tool that declares only the modern field", () => {
    expect(
      byId(run({ tools: [MODERN_TOOL], resources: [GOOD_RESOURCE] }), "claude.apps.resource-uri-modern")
        .status,
    ).toBe("satisfied");
  });

  it("passes a tool that declares both", () => {
    expect(
      byId(
        run({
          tools: [{ ...MODERN_TOOL, hasLegacyField: true }],
          resources: [GOOD_RESOURCE],
        }),
        "claude.apps.resource-uri-modern",
      ).status,
    ).toBe("satisfied");
  });

  it("fails only a tool that declares the legacy field alone", () => {
    const finding = byId(
      run({
        tools: [{ ...MODERN_TOOL, hasNestedField: false, hasLegacyField: true }],
        resources: [GOOD_RESOURCE],
      }),
      "claude.apps.resource-uri-modern",
    );
    expect(finding.status).toBe("violated");
    expect(finding.details).toMatchObject({ tools: ["show_order"] });
  });

  it("cites the apps-suite check it composes rather than re-running it", () => {
    expect(
      byId(run({ tools: [MODERN_TOOL], resources: [GOOD_RESOURCE] }), "claude.apps.resource-uri-modern")
        .derivedFrom,
    ).toContain("apps-conformance:ui-tool-metadata-valid");
  });
});

describe("the html mime profile", () => {
  it("fails plain text/html", () => {
    const finding = byId(
      run({
        tools: [MODERN_TOOL],
        resources: [{ uri: "ui://order", mimeType: "text/html" }],
      }),
      "claude.apps.html-mime-profile",
    );
    // A failure, not a warning: without the profile the host does not know the
    // payload is an app.
    expect(finding.status).toBe("violated");
    expect(finding.class).toBe("required");
  });

  it("tolerates a charset parameter alongside the profile", () => {
    // `charset` is legal on any `text/*` type and says nothing about the media
    // type. Rejecting it would fail a conforming widget on a `required` check.
    expect(
      byId(
        run({
          tools: [MODERN_TOOL],
          resources: [
            {
              uri: "ui://order",
              mimeType: "text/html;profile=mcp-app; charset=utf-8",
            },
          ],
        }),
        "claude.apps.html-mime-profile",
      ).status,
    ).toBe("satisfied");
  });

  it("accepts a quoted profile value", () => {
    expect(
      byId(
        run({
          tools: [MODERN_TOOL],
          resources: [
            { uri: "ui://order", mimeType: 'text/html;profile="mcp-app"' },
          ],
        }),
        "claude.apps.html-mime-profile",
      ).status,
    ).toBe("satisfied");
  });

  it("still rejects the essence alone, which carries no app signal", () => {
    expect(
      byId(
        run({
          tools: [MODERN_TOOL],
          resources: [{ uri: "ui://order", mimeType: "text/html; charset=utf-8" }],
        }),
        "claude.apps.html-mime-profile",
      ).status,
    ).toBe("violated");
  });

  it("tolerates spacing and case in the parameter", () => {
    expect(
      byId(
        run({
          tools: [MODERN_TOOL],
          resources: [{ uri: "ui://order", mimeType: "Text/HTML; profile=mcp-app" }],
        }),
        "claude.apps.html-mime-profile",
      ).status,
    ).toBe("satisfied");
  });
});

describe("OpenAI-only widgets", () => {
  const openAiTool = {
    name: "chart",
    resourceUri: "ui://chart",
    hasNestedField: false,
    hasLegacyField: false,
    hasOpenAiWidget: true,
  };

  it("blocks when the tool is app-only, because Claude renders nothing", () => {
    const finding = byId(
      run({
        tools: [{ ...openAiTool, toolMeta: { ui: { visibility: ["app"] } } }],
        resources: [],
      }),
      "claude.apps.openai-only-widget",
    );
    expect(finding.status).toBe("violated");
    expect(finding.class).toBe("runtime-blocker");
  });

  it("does not block a model-visible tool — degraded is not broken", () => {
    const finding = byId(
      run({
        tools: [{ ...openAiTool, hasTextualFallback: true }],
        resources: [],
      }),
      "claude.apps.openai-only-widget",
    );
    expect(finding.status).toBe("satisfied");
    // …and still names it, so a reviewer knows the UI is lost in Claude.
    expect(finding.details).toMatchObject({
      degraded: [{ name: "chart", hasTextualFallback: true }],
    });
  });
});

describe("ui.domain", () => {
  it("derives from the EXACT entered URL", () => {
    // A trailing slash changes the digest, so it must change the domain — a
    // check that canonicalized first would pass a value that fails in
    // production.
    expect(claudeAppContentDomain(URL_UNDER_TEST)).not.toBe(
      claudeAppContentDomain(`${URL_UNDER_TEST}/`),
    );
  });

  it("produces a 32-hex label under the Claude content host", () => {
    expect(claudeAppContentDomain(URL_UNDER_TEST)).toMatch(
      /^[0-9a-f]{32}\.claudemcpcontent\.com$/,
    );
  });

  it("pins the exact derivation, so a digest change cannot pass unnoticed", () => {
    // Neither of the assertions above would catch a switch to a different
    // digest, a different slice offset, or a lower-cased input — each of which
    // satisfies "differs on differing input" and "looks like 32 hex" while
    // breaking every deployed widget.
    const expected = `${createHash("sha256")
      .update(URL_UNDER_TEST)
      .digest("hex")
      .slice(0, 32)}.claudemcpcontent.com`;
    expect(claudeAppContentDomain(URL_UNDER_TEST)).toBe(expected);
  });

  it("is not applicable when no resource sets one", () => {
    expect(
      byId(
        run({ tools: [MODERN_TOOL], resources: [GOOD_RESOURCE] }),
        "claude.apps.ui-domain-derivation",
      ).status,
    ).toBe("not-applicable");
  });

  it("passes an exactly-derived domain", () => {
    expect(
      byId(
        run({
          tools: [MODERN_TOOL],
          resources: [
            { ...GOOD_RESOURCE, domain: claudeAppContentDomain(URL_UNDER_TEST) },
          ],
        }),
        "claude.apps.ui-domain-derivation",
      ).status,
    ).toBe("satisfied");
  });

  it("fails a domain derived from the trailing-slash form and says why", () => {
    const finding = byId(
      run({
        tools: [MODERN_TOOL],
        resources: [
          { ...GOOD_RESOURCE, domain: claudeAppContentDomain(`${URL_UNDER_TEST}/`) },
        ],
      }),
      "claude.apps.ui-domain-derivation",
    );
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toMatch(/trailing slash/);
    expect(finding.details).toMatchObject({ hashedInput: URL_UNDER_TEST });
  });

  it("only advises about an absent domain when the app owns its OAuth", () => {
    expect(
      byId(
        run({ tools: [MODERN_TOOL], resources: [GOOD_RESOURCE] }),
        "claude.apps.ui-domain-recommended-for-app-oauth",
      ).status,
    ).toBe("satisfied");
    const advised = byId(
      run({ tools: [MODERN_TOOL], resources: [GOOD_RESOURCE], appOwnedOAuth: true }),
      "claude.apps.ui-domain-recommended-for-app-oauth",
    );
    expect(advised.status).toBe("violated");
    // An advisory, so it can never fail the lane.
    expect(advised.class).toBe("recommended");
  });
});

describe("the result-size budget is not a static check", () => {
  it("is reported as an unevaluated functional observation", () => {
    const finding = byId(
      run({ tools: [MODERN_TOOL], resources: [GOOD_RESOURCE] }),
      "claude.apps.result-size-budget",
    );
    expect(finding.status).toBe("not-evaluated");
    expect(finding.notEvaluatedReason).toMatch(/per CALL/);
  });
});

describe("design-guideline lints", () => {
  const bareHtml = "<html><body><button>Go</button></body></html>";
  const carefulHtml = `<html><head><style>
    @media (max-width: 320px) { body { padding: 0 } }
    button { min-height: 44px }
    body { padding: env(safe-area-inset-bottom) }
    @media (prefers-color-scheme: dark) { body { color: #fff } }
  </style></head><body><button role="button" aria-label="Go" data-display-mode="inline">Go</button></body></html>`;

  it("never fails a lane, whatever it finds", () => {
    const findings = run({
      tools: [MODERN_TOOL],
      resources: [{ ...GOOD_RESOURCE, html: bareHtml }],
    }).filter((finding) => finding.id.startsWith("claude.apps.design."));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.class === "heuristic")).toBe(true);
    expect(decideLaneStatus(findings)).toBe("incomplete");
  });

  it("flags a bare widget across the guideline set", () => {
    const flagged = run({
      tools: [MODERN_TOOL],
      resources: [{ ...GOOD_RESOURCE, html: bareHtml }],
    }).filter(
      (finding) =>
        finding.id.startsWith("claude.apps.design.") && finding.status === "violated",
    );
    expect(flagged.map((f) => f.id)).toEqual(
      expect.arrayContaining([
        "claude.apps.design.responsive-320",
        "claude.apps.design.touch-targets",
        "claude.apps.design.safe-area",
        "claude.apps.design.theming",
        "claude.apps.design.accessibility",
      ]),
    );
  });

  it("counts inline style declarations, not only <style> blocks", () => {
    // `<button style="min-height: 44px">` satisfies the guideline exactly as
    // well as a stylesheet does. Reading only `<style>` bodies would report a
    // violation the author already fixed.
    const inlineHtml =
      '<html><body><button style="min-height: 48px" aria-label="Go">Go</button></body></html>';
    const flagged = run({
      tools: [MODERN_TOOL],
      resources: [{ ...GOOD_RESOURCE, html: inlineHtml }],
    }).filter(
      (finding) =>
        finding.id === "claude.apps.design.touch-targets" &&
        finding.status === "violated",
    );
    expect(flagged).toEqual([]);
  });

  it("reads the touch-target minimum as a number, not as digits in a regex", () => {
    const touchTarget = (html: string) =>
      run({
        tools: [MODERN_TOOL],
        resources: [{ ...GOOD_RESOURCE, html }],
      }).find((f) => f.id === "claude.apps.design.touch-targets")!.status;

    // Exactly the budget passes, and so does the logical property — which the
    // old regex accepted at ANY value, including ones far below the minimum.
    expect(
      touchTarget(
        `<html><body><button style="min-height: ${CLAUDE_APP_DESIGN_BUDGETS.minTouchTargetPx}px" aria-label="Go">Go</button></body></html>`,
      ),
    ).toBe("satisfied");
    expect(
      touchTarget(
        '<html><body><button style="min-block-size: 48px" aria-label="Go">Go</button></body></html>',
      ),
    ).toBe("satisfied");
    expect(
      touchTarget(
        '<html><body><button style="min-block-size: 8px" aria-label="Go">Go</button></body></html>',
      ),
    ).toBe("violated");
    // A fractional value below the budget is still below it.
    expect(
      touchTarget(
        '<html><body><button style="min-height: 43.5px" aria-label="Go">Go</button></body></html>',
      ),
    ).toBe("violated");
  });

  it("does not see a button that exists only inside a comment", () => {
    // The regexes this scanner replaced matched markup anywhere in the file,
    // including commented-out code, and then demanded ARIA on an element the
    // widget does not have.
    const commented =
      "<html><body><!-- <button>old</button> --><p>text</p></body></html>";
    const flagged = run({
      tools: [MODERN_TOOL],
      resources: [{ ...GOOD_RESOURCE, html: commented }],
    }).filter(
      (finding) =>
        (finding.id === "claude.apps.design.accessibility" ||
          finding.id === "claude.apps.design.touch-targets") &&
        finding.status === "violated",
    );
    expect(flagged).toEqual([]);
  });

  it("clears a careful widget", () => {
    const flagged = run({
      tools: [MODERN_TOOL],
      resources: [{ ...GOOD_RESOURCE, html: carefulHtml }],
    }).filter(
      (finding) =>
        finding.id.startsWith("claude.apps.design.") && finding.status === "violated",
    );
    expect(flagged).toEqual([]);
  });

  it("labels its provenance honestly as a static read", () => {
    // Even with a browser in the run, these lints read markup. Calling them a
    // `browser` observation would overstate what produced the signal.
    const finding = run({
      tools: [MODERN_TOOL],
      resources: [{ ...GOOD_RESOURCE, html: bareHtml }],
      renderEngine: "node-approximation",
    }).find((f) => f.id === "claude.apps.design.theming")!;
    expect(finding.provenance).toBe("static");
    expect(finding.details).toMatchObject({
      renderEngine: "node-approximation",
      basis: "static markup analysis, not a rendered observation",
    });
  });

  it("cannot run at all without widget HTML", () => {
    const findings = run({
      tools: [MODERN_TOOL],
      resources: [GOOD_RESOURCE],
    }).filter((finding) => finding.id.startsWith("claude.apps.design."));
    expect(findings.every((f) => f.status === "not-evaluated")).toBe(true);
  });
});

describe("instance supersession", () => {
  it("is only tested for a widget that claims a single active instance", () => {
    expect(
      byId(
        run({ tools: [MODERN_TOOL], resources: [GOOD_RESOURCE] }),
        "claude.apps.instance-supersession",
      ).status,
    ).toBe("not-applicable");
    expect(
      byId(
        run({
          tools: [MODERN_TOOL],
          resources: [{ ...GOOD_RESOURCE, claimsSingleActiveInstance: true }],
        }),
        "claude.apps.instance-supersession",
      ).status,
    ).toBe("not-evaluated");
  });
});

describe("composition helpers", () => {
  it("reads the modern, legacy and OpenAI fields apart", () => {
    expect(
      claudeAppToolEvidenceFrom({
        name: "a",
        _meta: { ui: { resourceUri: "ui://a" } },
      }),
    ).toMatchObject({ hasNestedField: true, hasLegacyField: false });
    expect(
      claudeAppToolEvidenceFrom({ name: "b", _meta: { "ui/resourceUri": "ui://b" } }),
    ).toMatchObject({ hasNestedField: false, hasLegacyField: true });
    expect(
      claudeAppToolEvidenceFrom({
        name: "c",
        _meta: { "openai/outputTemplate": "ui://c" },
      }),
    ).toMatchObject({ hasOpenAiWidget: true, hasNestedField: false });
  });

  it("returns nothing for an ordinary tool", () => {
    expect(claudeAppToolEvidenceFrom({ name: "plain" })).toBeUndefined();
  });

  it("keeps HTML only when the mime type says HTML", () => {
    expect(
      claudeAppResourceEvidenceFrom({
        uri: "ui://a",
        mimeType: "application/json",
        text: '{"not":"html"}',
      }).html,
    ).toBeUndefined();
    expect(
      claudeAppResourceEvidenceFrom({
        uri: "ui://a",
        mimeType: "text/html;profile=mcp-app",
        text: "<html></html>",
      }).html,
    ).toBe("<html></html>");
  });

  it("lifts ui.domain and ui.csp out of the resource meta", () => {
    expect(
      claudeAppResourceEvidenceFrom({
        uri: "ui://a",
        mimeType: "text/html;profile=mcp-app",
        _meta: { ui: { domain: "abc.claudemcpcontent.com", csp: { "connect-src": ["*"] } } },
      }),
    ).toMatchObject({
      domain: "abc.claudemcpcontent.com",
      csp: { "connect-src": ["*"] },
    });
  });
});

describe("CSP shape", () => {
  it("advises against a wildcard", () => {
    expect(
      byId(
        run({
          tools: [MODERN_TOOL],
          resources: [{ ...GOOD_RESOURCE, csp: { "connect-src": ["https://*"] } }],
        }),
        "claude.apps.csp-shape",
      ).status,
    ).toBe("violated");
  });

  it("catches a wildcard written as a bare string rather than a list", () => {
    expect(
      byId(
        run({
          tools: [MODERN_TOOL],
          resources: [
            { ...GOOD_RESOURCE, csp: { "connect-src": "https://*.example.com" } },
          ],
        }),
        "claude.apps.csp-shape",
      ).status,
    ).toBe("violated");
  });

  it("accepts named hosts", () => {
    expect(
      byId(
        run({
          tools: [MODERN_TOOL],
          resources: [
            { ...GOOD_RESOURCE, csp: { "connect-src": ["https://api.example.com"] } },
          ],
        }),
        "claude.apps.csp-shape",
      ).status,
    ).toBe("satisfied");
  });
});
