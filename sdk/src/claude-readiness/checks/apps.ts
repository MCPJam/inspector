/**
 * Claude-specific MCP Apps checks.
 *
 * COMPOSITION IS THE POINT. `apps-conformance` already grades whether a widget
 * is a valid MCP App, and `host-compat` already grades which hosts can render
 * it. Neither is re-run here. This module consumes their results as evidence
 * and adds only what is CLAUDE'S — the content-domain derivation, the MIME
 * profile Claude requires, what Claude does with an OpenAI-only widget — plus
 * the design-guideline lints, which are advisories because a static read of
 * HTML cannot establish how something renders.
 *
 * Re-running an equivalent check would let readiness and the apps suite
 * disagree about the same server, and the first question anyone asks about a
 * disagreement is which one to believe.
 *
 * Pure data. No transport, no browser.
 */

import { sha256Hex } from "../../contract/canonical.js";
import {
  hasAccessibilityAffordance,
  hasInteractiveElement,
  scanHtml,
  type ScannedHtml,
} from "../html-scan.js";
import { getToolVisibility } from "../../widget-runtime/tool-visibility.js";
import { claudePolicySource } from "../manifest.js";
import {
  CLAUDE_APP_CONTENT_DOMAIN_HASH_LENGTH,
  CLAUDE_APP_CONTENT_DOMAIN_SUFFIX,
  CLAUDE_APP_DESIGN_BUDGETS,
  CLAUDE_APP_HTML_MIME,
} from "../profile.js";
import type { ClaudeReadinessFinding } from "../types.js";
import {
  derivedFrom,
  notApplicable,
  notEvaluated,
  satisfied,
  violated,
  type ClaudeCheckDefinition,
  type ClaudeCheckStamp,
} from "./helpers.js";

// ── Evidence ────────────────────────────────────────────────────────────

/** One widget-bearing tool, as the apps suite already resolved it. */
export interface ClaudeAppToolEvidence {
  name: string;
  resourceUri: string;
  /** The tool declared `_meta.ui.resourceUri` — the modern field. */
  hasNestedField: boolean;
  /** The tool declared the deprecated `_meta["ui/resourceUri"]`. */
  hasLegacyField: boolean;
  /** Raw `_meta` so the shared visibility helper reads it, not a copy. */
  toolMeta?: Record<string, unknown>;
  /** The tool also carries an OpenAI-only widget template. */
  hasOpenAiWidget?: boolean;
  /** The tool returns usable text when no widget renders. */
  hasTextualFallback?: boolean;
}

/** One widget resource, as read. */
export interface ClaudeAppResourceEvidence {
  uri: string;
  mimeType?: string;
  /** `_meta.ui.domain`, when the resource set one. */
  domain?: string;
  /** `_meta.ui.csp`, when present. */
  csp?: Record<string, unknown>;
  /** The HTML text, for the static design lints. Absent ⇒ they cannot run. */
  html?: string;
  /** The widget declares it supports only one active instance. */
  claimsSingleActiveInstance?: boolean;
}

export interface ClaudeAppsEvidence {
  /** The connector URL exactly as entered — the content domain derives from it. */
  enteredUrl: string;
  /**
   * Whether an apps-conformance result was consumed. `false` means the run had
   * no apps evidence at all, which is different from a server with no apps.
   */
  appsSuiteRan: boolean;
  tools?: ClaudeAppToolEvidence[];
  resources?: ClaudeAppResourceEvidence[];
  /** The widget's OAuth is owned by the app rather than the connector. */
  appOwnedOAuth?: boolean;
  /**
   * How a rendering observation was obtained, when there was one. Node's
   * `Origin` probe APPROXIMATES WebKit; it is not WebKit, and a finding built
   * on it must say so rather than claim a browser observation it did not make.
   */
  renderEngine?: "webkit" | "chromium" | "node-approximation";
}

// ── Definitions ─────────────────────────────────────────────────────────

/**
 * The input that closes this module's coverage gap.
 *
 * Distinct from the tool-listing input: a run can hold a tool listing and
 * still have no apps evidence, because reading widget resources is a separate
 * round trip the caller may not have made.
 */
export const CLAUDE_APPS_RESULT_INPUT = "appsResult";

const RESOURCE_URI_MODERNITY: ClaudeCheckDefinition = {
  id: "claude.apps.resource-uri-modern",
  title: "Widget tools declare `_meta.ui.resourceUri`",
  lane: "runtime-compatibility",
  class: "required",
  source: claudePolicySource("mcp-apps/cross-compatibility", "§Tool metadata"),
  provenance: "static",
  intrusiveness: "passive",
};

const HTML_MIME_PROFILE: ClaudeCheckDefinition = {
  id: "claude.apps.html-mime-profile",
  title: `Widget resources are served as \`${CLAUDE_APP_HTML_MIME}\``,
  lane: "runtime-compatibility",
  class: "required",
  source: claudePolicySource("mcp-apps/cross-compatibility", "§Resource mime type"),
  provenance: "wire",
};

const OPENAI_ONLY_WIDGET: ClaudeCheckDefinition = {
  id: "claude.apps.openai-only-widget",
  title: "No tool renders only through an OpenAI-specific widget",
  lane: "runtime-compatibility",
  class: "runtime-blocker",
  source: claudePolicySource("mcp-apps/cross-compatibility", "§Other hosts"),
  provenance: "static",
  intrusiveness: "passive",
};

const UI_DOMAIN_DERIVATION: ClaudeCheckDefinition = {
  id: "claude.apps.ui-domain-derivation",
  title: "`ui.domain`, when set, is the domain Claude will serve",
  lane: "runtime-compatibility",
  class: "required",
  source: claudePolicySource("mcp-apps/external-links", "§Content domain"),
  provenance: "static",
  intrusiveness: "passive",
};

const UI_DOMAIN_ADVISED: ClaudeCheckDefinition = {
  id: "claude.apps.ui-domain-recommended-for-app-oauth",
  title: "An app-owned OAuth widget benefits from a stable content domain",
  lane: "experience-insights",
  class: "recommended",
  source: claudePolicySource("mcp-apps/external-links", "§Content domain"),
  provenance: "static",
  intrusiveness: "passive",
};

const CSP_SHAPE: ClaudeCheckDefinition = {
  id: "claude.apps.csp-shape",
  title: "A declared CSP names only hosts the widget actually needs",
  lane: "experience-insights",
  class: "recommended",
  source: claudePolicySource("mcp-apps/external-links", "§Content security policy"),
  provenance: "static",
  intrusiveness: "passive",
};

const RESULT_SIZE: ClaudeCheckDefinition = {
  id: "claude.apps.result-size-budget",
  title: "Tool results stay inside Claude's per-call size budget",
  lane: "experience-insights",
  // NOT a static check. The threshold is per CALL, so it depends on the
  // arguments a caller passes — a tool that is fine on one query and enormous
  // on another has no static verdict. It belongs to a functional run.
  class: "manual-review",
  source: claudePolicySource("mcp-apps/troubleshooting", "§Result size"),
  provenance: "wire",
};

const INSTANCE_SUPERSESSION: ClaudeCheckDefinition = {
  id: "claude.apps.instance-supersession",
  title: "A single-instance widget yields correctly when superseded",
  lane: "experience-insights",
  class: "heuristic",
  source: claudePolicySource("mcp-apps/design-guidelines", "§Instances"),
  provenance: "browser",
  requiresCapabilities: ["browser"],
};

/**
 * The design guidelines, as static lints.
 *
 * Every one of these is a HEURISTIC and none can fail a lane, because a static
 * read of HTML cannot establish how something renders. "No `@media` query" is
 * evidence a widget may not be responsive; a widget laid out entirely in
 * container queries or intrinsic sizing has none either and is perfectly
 * responsive. The value is in pointing a reviewer at the likely places, not in
 * pronouncing a verdict.
 */
/**
 * Whether the stylesheet declares a block-axis minimum that reaches Claude's
 * touch-target budget.
 *
 * Both spellings count — `min-height` and its logical equivalent
 * `min-block-size` — and both are read as NUMBERS, so the lint tracks
 * {@link CLAUDE_APP_DESIGN_BUDGETS} instead of restating it. Only `px` is
 * considered: a relative unit cannot be resolved without a layout, and
 * guessing at one would be a rendered observation this static pass never made.
 */
function declaresMinimumTouchTarget(styleText: string): boolean {
  const declarations = styleText.matchAll(
    /min-(?:height|block-size)\s*:\s*([\d.]+)px/gi,
  );
  for (const [, value] of declarations) {
    if (Number.parseFloat(value) >= CLAUDE_APP_DESIGN_BUDGETS.minTouchTargetPx) {
      return true;
    }
  }
  return false;
}

const DESIGN_LINTS: Array<{
  definition: ClaudeCheckDefinition;
  /** True when the widget looks like it MISSES the guideline. */
  detect: (scanned: ScannedHtml) => boolean;
  remediation: string;
}> = [
  {
    definition: designLint(
      "responsive-320",
      "Widget appears to have no narrow-viewport handling",
      "§Responsiveness",
    ),
    detect: (scanned) =>
      !/@media[^{]*\(\s*max-width/i.test(scanned.styleText) &&
      !/@container/i.test(scanned.styleText) &&
      !/\bminmax\(|\bclamp\(|\bflex-wrap\b/i.test(scanned.styleText),
    remediation: `Claude renders widgets as narrow as ${CLAUDE_APP_DESIGN_BUDGETS.minViewportWidthPx}px. No media query, container query, or intrinsic sizing was found.`,
  },
  {
    definition: designLint(
      "touch-targets",
      `Interactive elements may be below the ${CLAUDE_APP_DESIGN_BUDGETS.minTouchTargetPx}×${CLAUDE_APP_DESIGN_BUDGETS.minTouchTargetPx}px touch target`,
      "§Touch targets",
    ),
    // Read the declared minimums and COMPARE them, rather than pattern-matching
    // the digits of one particular number: a regex spelling out `4[4-9]|[5-9]\d`
    // silently stops agreeing with the budget the moment the budget changes,
    // and it could only ever check `min-height` while treating any
    // `min-block-size` at all — including `min-block-size: 8px` — as passing.
    detect: (scanned) =>
      hasInteractiveElement(scanned) &&
      !declaresMinimumTouchTarget(scanned.styleText),
    remediation: `Interactive controls were found with no minimum height reaching ${CLAUDE_APP_DESIGN_BUDGETS.minTouchTargetPx}px.`,
  },
  {
    definition: designLint(
      "safe-area",
      "Widget does not account for the device safe area",
      "§Safe areas",
    ),
    detect: (scanned) => !/safe-area-inset/i.test(scanned.styleText),
    remediation:
      "No `env(safe-area-inset-*)` usage was found; content can sit under a notch or home indicator.",
  },
  {
    definition: designLint(
      "theming",
      "Widget appears not to follow the host's light/dark theme",
      "§Theming",
    ),
    detect: (scanned) =>
      !/prefers-color-scheme/i.test(scanned.styleText) &&
      !/color-scheme/i.test(scanned.styleText) &&
      !scanned.attributes.has("data-theme"),
    remediation:
      "No `prefers-color-scheme`, `color-scheme`, or theme attribute was found; the widget will not follow Claude's theme.",
  },
  {
    definition: designLint(
      "transparent-background",
      "Widget paints an opaque background over the host surface",
      "§Backgrounds",
    ),
    detect: (scanned) =>
      /body\s*{[^}]*background(-color)?\s*:\s*(#|rgb|hsl|white|black)/i.test(
        scanned.styleText,
      ),
    remediation:
      "The widget paints its own body background; Claude's surface shows through a transparent one.",
  },
  {
    definition: designLint(
      "nested-scrolling",
      "Widget introduces its own scroll container",
      "§Scrolling",
    ),
    detect: (scanned) =>
      /overflow(-y)?\s*:\s*(auto|scroll)/i.test(scanned.styleText),
    remediation:
      "A nested scroll region was found. Claude scrolls the conversation, and a scroll-within-a-scroll is hard to use on touch.",
  },
  {
    definition: designLint(
      "accessibility",
      "Widget shows few accessibility affordances",
      "§Accessibility",
    ),
    detect: (scanned) =>
      hasInteractiveElement(scanned) && !hasAccessibilityAffordance(scanned),
    remediation: "Interactive elements carry no ARIA attributes or roles.",
  },
  {
    definition: designLint(
      "display-mode",
      "Widget does not react to the host's display mode",
      "§Display modes",
    ),
    detect: (scanned) =>
      !/displayMode/i.test(scanned.scriptText) &&
      !/display-mode/i.test(scanned.styleText) &&
      !scanned.attributes.has("data-display-mode"),
    remediation:
      "No reference to the host display mode was found; the widget will render identically inline and fullscreen.",
  },
];

function designLint(
  slug: string,
  title: string,
  section: string,
): ClaudeCheckDefinition {
  return {
    id: `claude.apps.design.${slug}`,
    title,
    lane: "experience-insights",
    class: "heuristic",
    source: claudePolicySource("mcp-apps/design-guidelines", section),
    provenance: "static",
    intrusiveness: "passive",
  };
}

// ── Derivation ──────────────────────────────────────────────────────────

/**
 * The content domain Claude serves a widget from.
 *
 * `sha256(<exact connector URL>)`, first 32 hex characters, plus the suffix.
 * "Exact" is load-bearing: a trailing slash, a different scheme, or a
 * normalised port produces a different digest and therefore a domain Claude
 * will not serve. So this hashes the URL AS ENTERED and never canonicalizes —
 * canonicalizing here would make the check pass for a value that fails in
 * production, which is worse than not checking at all.
 */
export function claudeAppContentDomain(enteredUrl: string): string {
  const digest = sha256Hex(enteredUrl).slice(
    0,
    CLAUDE_APP_CONTENT_DOMAIN_HASH_LENGTH,
  );
  return `${digest}${CLAUDE_APP_CONTENT_DOMAIN_SUFFIX}`;
}

// ── The run ─────────────────────────────────────────────────────────────

export function runClaudeAppsChecks(
  evidence: ClaudeAppsEvidence,
  stamp: ClaudeCheckStamp,
): ClaudeReadinessFinding[] {
  const findings: ClaudeReadinessFinding[] = [];
  const tools = evidence.tools ?? [];
  const resources = evidence.resources ?? [];

  const staticDefinitions = [
    RESOURCE_URI_MODERNITY,
    HTML_MIME_PROFILE,
    OPENAI_ONLY_WIDGET,
    UI_DOMAIN_DERIVATION,
    UI_DOMAIN_ADVISED,
    CSP_SHAPE,
  ];

  /**
   * EVERY definition this module can emit, which is what an early return owes
   * the report.
   *
   * The design lints were missing here, so a run with no apps evidence — or a
   * server with no widgets — silently produced eight fewer findings than the
   * catalog advertises. Absent is not the same as `not-evaluated`: one is a
   * check the report can explain, the other is a hole a reader has to notice.
   */
  const everyDefinition = [
    ...staticDefinitions,
    RESULT_SIZE,
    INSTANCE_SUPERSESSION,
    ...DESIGN_LINTS.map((lint) => lint.definition),
  ];

  if (!evidence.appsSuiteRan) {
    // No apps evidence at all is NOT "this server has no apps". Saying
    // `not-applicable` would claim we established something we never looked at.
    const reason =
      "no MCP Apps conformance result was available, so nothing app-specific was evaluated";
    for (const definition of everyDefinition) {
      findings.push(notEvaluated(definition, stamp, reason, {
        missingInput: CLAUDE_APPS_RESULT_INPUT,
      }));
    }
    return findings;
  }

  if (tools.length === 0) {
    const reason = "this server advertises no MCP Apps widgets";
    for (const definition of everyDefinition) {
      findings.push(notApplicable(definition, stamp, reason));
    }
    return findings;
  }

  // ── resourceUri modernity ────────────────────────────────────────────
  // The modern field ALONE is correct and complete. Only a tool that declares
  // the deprecated field and nothing else is a problem — an earlier reading
  // that warned whenever the legacy field was absent had it exactly backwards.
  const legacyOnly = tools.filter(
    (tool) => tool.hasLegacyField && !tool.hasNestedField,
  );
  findings.push(
    derivedFrom(
      legacyOnly.length === 0
        ? satisfied(RESOURCE_URI_MODERNITY, stamp, {
            tools: tools.length,
            modernOnly: tools.filter((t) => t.hasNestedField && !t.hasLegacyField)
              .length,
          })
        : violated(
            RESOURCE_URI_MODERNITY,
            stamp,
            "Declare `_meta.ui.resourceUri`. These tools use only the deprecated `ui/resourceUri` field, which Claude does not read.",
            { tools: legacyOnly.map((tool) => tool.name) },
          ),
      "apps-conformance:ui-tool-metadata-valid",
    ),
  );

  // ── MIME profile ─────────────────────────────────────────────────────
  const wrongMime = resources.filter(
    (resource) =>
      resource.mimeType !== undefined && !isClaudeAppMime(resource.mimeType),
  );
  const unknownMime = resources.filter(
    (resource) => resource.mimeType === undefined,
  );
  findings.push(
    resources.length === 0
      ? notEvaluated(
          HTML_MIME_PROFILE,
          stamp,
          "no widget resources were read, so their mime types are unknown",
        )
      : wrongMime.length === 0 && unknownMime.length === 0
        ? satisfied(HTML_MIME_PROFILE, stamp, { resources: resources.length })
        : violated(
            HTML_MIME_PROFILE,
            stamp,
            `Serve widget resources as \`${CLAUDE_APP_HTML_MIME}\`. Plain \`text/html\` does not tell the host the payload is an app.`,
            {
              wrong: wrongMime.map((r) => ({ uri: r.uri, mimeType: r.mimeType })),
              missing: unknownMime.map((r) => r.uri),
            },
          ),
  );

  // ── OpenAI-only widgets ──────────────────────────────────────────────
  // A blocker ONLY when the tool is app-only. A model-visible tool with a
  // textual fallback still works in Claude — degraded, not broken — and
  // failing it would tell a submitter their working connector is unusable.
  const openAiTools = tools.filter(
    (tool) => tool.hasOpenAiWidget && !tool.hasNestedField && !tool.hasLegacyField,
  );
  const blocking = openAiTools.filter((tool) => isAppOnly(tool));
  const degraded = openAiTools.filter((tool) => !isAppOnly(tool));
  findings.push(
    openAiTools.length === 0
      ? satisfied(OPENAI_ONLY_WIDGET, stamp)
      : blocking.length > 0
        ? violated(
            OPENAI_ONLY_WIDGET,
            stamp,
            "These tools render only through an OpenAI-specific widget and are app-only, so in Claude they produce nothing at all. Add an MCP Apps resource or make the tool model-visible with a textual result.",
            {
              blocking: blocking.map((tool) => tool.name),
              degraded: degraded.map((tool) => tool.name),
            },
          )
        : satisfied(OPENAI_ONLY_WIDGET, stamp, {
            // Named rather than silent: the connector works, and the reviewer
            // should still know these tools lose their UI in Claude.
            degraded: degraded.map((tool) => ({
              name: tool.name,
              hasTextualFallback: tool.hasTextualFallback ?? false,
            })),
          }),
  );

  // ── ui.domain ────────────────────────────────────────────────────────
  const expectedDomain = claudeAppContentDomain(evidence.enteredUrl);
  const withDomain = resources.filter((resource) => resource.domain !== undefined);
  const mismatched = withDomain.filter(
    (resource) => resource.domain !== expectedDomain,
  );
  findings.push(
    withDomain.length === 0
      ? notApplicable(
          UI_DOMAIN_DERIVATION,
          stamp,
          "`ui.domain` is optional and no resource set one",
        )
      : mismatched.length === 0
        ? satisfied(UI_DOMAIN_DERIVATION, stamp, { domain: expectedDomain })
        : violated(
            UI_DOMAIN_DERIVATION,
            stamp,
            `\`ui.domain\` must be exactly \`${expectedDomain}\` — sha256 of the connector URL as entered, first ${CLAUDE_APP_CONTENT_DOMAIN_HASH_LENGTH} hex characters, plus \`${CLAUDE_APP_CONTENT_DOMAIN_SUFFIX}\`. A trailing slash or a different scheme in the URL changes the digest.`,
            {
              expected: expectedDomain,
              found: mismatched.map((r) => ({ uri: r.uri, domain: r.domain })),
              hashedInput: evidence.enteredUrl,
            },
          ),
  );

  findings.push(
    withDomain.length > 0
      ? notApplicable(
          UI_DOMAIN_ADVISED,
          stamp,
          "the widget already declares a content domain",
        )
      : evidence.appOwnedOAuth
        ? violated(
            UI_DOMAIN_ADVISED,
            stamp,
            "This widget owns its own OAuth but declares no `ui.domain`, so its origin changes with the connector URL and stored credentials will not survive.",
            { suggested: expectedDomain },
          )
        : satisfied(UI_DOMAIN_ADVISED, stamp),
  );

  // ── CSP ──────────────────────────────────────────────────────────────
  const wildcardCsp = resources.filter((resource) =>
    Object.values(resource.csp ?? {}).some((value) => {
      // A directive may be written as a single string rather than a list; a
      // wildcard hidden in that form is the same wildcard.
      const entries = Array.isArray(value) ? value : [value];
      return entries.some(
        (entry) => typeof entry === "string" && entry.includes("*"),
      );
    }),
  );
  findings.push(
    resources.every((resource) => resource.csp === undefined)
      ? notApplicable(CSP_SHAPE, stamp, "no widget declares a content security policy")
      : wildcardCsp.length === 0
        ? satisfied(CSP_SHAPE, stamp)
        : violated(
            CSP_SHAPE,
            stamp,
            "A wildcard in `_meta.ui.csp` grants the widget more reach than it needs; name the hosts it actually calls.",
            { resources: wildcardCsp.map((r) => r.uri) },
          ),
  );

  // ── Call-specific and browser-only observations ──────────────────────
  findings.push(
    notEvaluated(
      RESULT_SIZE,
      stamp,
      "the result-size budget is per CALL, so it depends on the arguments a caller passes and has no static verdict; it is observed by a functional run",
    ),
  );

  const singleInstance = resources.filter(
    (resource) => resource.claimsSingleActiveInstance,
  );
  findings.push(
    singleInstance.length === 0
      ? notApplicable(
          INSTANCE_SUPERSESSION,
          stamp,
          "no widget claims a single active instance, so there is no supersession contract to test",
        )
      : notEvaluated(
          INSTANCE_SUPERSESSION,
          stamp,
          "verifying supersession requires rendering two instances in a browser harness",
          { resources: singleInstance.map((r) => r.uri) },
        ),
  );

  // ── Design guideline lints ───────────────────────────────────────────
  findings.push(...runDesignLints(evidence, resources, stamp));

  return findings;
}

function runDesignLints(
  evidence: ClaudeAppsEvidence,
  resources: ClaudeAppResourceEvidence[],
  stamp: ClaudeCheckStamp,
): ClaudeReadinessFinding[] {
  const withHtml = resources.filter(
    (resource): resource is ClaudeAppResourceEvidence & { html: string } =>
      typeof resource.html === "string" && resource.html.length > 0,
  );

  if (withHtml.length === 0) {
    return DESIGN_LINTS.map((lint) =>
      notEvaluated(
        lint.definition,
        stamp,
        "no widget HTML was captured, so the static design lints could not run",
      ),
    );
  }

  // Scanned ONCE per resource, not once per lint: eight regex passes over the
  // same markup would be eight chances to disagree about what is in it.
  const scanned = withHtml.map((resource) => ({
    resource,
    html: scanHtml(resource.html),
  }));

  return DESIGN_LINTS.map((lint) => {
    const flagged = scanned
      .filter((entry) => lint.detect(entry.html))
      .map((entry) => entry.resource);
    // PROVENANCE IS HONEST HERE. These are `static` reads of markup even when
    // the run also had a browser: a rendering engine was not what produced
    // this signal, and labelling it `browser` would overstate the evidence.
    // Where a WebKit harness IS available its observations arrive as separate
    // findings, because Node's `Origin` probe only approximates WebKit.
    return flagged.length === 0
      ? satisfied(lint.definition, stamp, {
          resources: withHtml.length,
          renderEngine: evidence.renderEngine ?? "none",
        })
      : violated(lint.definition, stamp, lint.remediation, {
          resources: flagged.map((resource) => resource.uri),
          renderEngine: evidence.renderEngine ?? "none",
          // Said out loud on every lint: this is a reading of markup, not an
          // observation of a rendered widget.
          basis: "static markup analysis, not a rendered observation",
        });
  });
}

/**
 * Whether a served mime type is the MCP App profile Claude requires.
 *
 * The comparison cannot be a string equality against
 * `"text/html;profile=mcp-app"`. A `charset` parameter is legal on any `text/*`
 * type and says nothing about the media type, so `text/html;profile=mcp-app;
 * charset=utf-8` is a CONFORMING resource that a literal comparison would fail
 * — and this is a `required` runtime check, so that false violation would tell
 * a submitter to break a widget that works.
 *
 * It also cannot compare the essence alone: `profile=mcp-app` is the entire
 * signal that the payload is an app rather than a document, and dropping it
 * would make the check pass for plain `text/html`.
 *
 * So: essence must be `text/html`, the `profile` parameter must be `mcp-app`,
 * and every other parameter is ignored.
 */
function isClaudeAppMime(mimeType: string): boolean {
  const [rawEssence, ...rawParameters] = mimeType.split(";");
  if (rawEssence.trim().toLowerCase() !== CLAUDE_APP_HTML_ESSENCE) return false;
  for (const parameter of rawParameters) {
    const separator = parameter.indexOf("=");
    if (separator === -1) continue;
    const name = parameter.slice(0, separator).trim().toLowerCase();
    if (name !== "profile") continue;
    // Quoted parameter values are legal: `profile="mcp-app"`.
    const value = parameter
      .slice(separator + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .toLowerCase();
    return value === CLAUDE_APP_PROFILE_VALUE;
  }
  return false;
}

/** The two halves of {@link CLAUDE_APP_HTML_MIME}, split once. */
const CLAUDE_APP_HTML_ESSENCE = CLAUDE_APP_HTML_MIME.split(";")[0]
  .trim()
  .toLowerCase();
const CLAUDE_APP_PROFILE_VALUE = "mcp-app";

function isAppOnly(tool: ClaudeAppToolEvidence): boolean {
  const visibility = getToolVisibility(tool.toolMeta);
  return visibility.length === 1 && visibility[0] === "app";
}

// ── Composition from what the run already has ───────────────────────────

/**
 * Build tool evidence from a listed tool's `_meta`.
 *
 * The apps suite's own result reports tool NAMES and resource URIs, not the
 * per-tool metadata these checks need (modern vs legacy field, visibility, an
 * OpenAI template). So the raw tool is the input and the suite result is
 * consumed for its VERDICT — cited via `derivedFrom` — rather than mined for
 * data it does not carry.
 *
 * Returns `undefined` for a tool with no widget at all, which is most tools.
 */
export function claudeAppToolEvidenceFrom(tool: {
  name: string;
  _meta?: unknown;
}): ClaudeAppToolEvidence | undefined {
  const meta =
    typeof tool._meta === "object" && tool._meta !== null && !Array.isArray(tool._meta)
      ? (tool._meta as Record<string, unknown>)
      : undefined;
  const ui =
    typeof meta?.ui === "object" && meta.ui !== null && !Array.isArray(meta.ui)
      ? (meta.ui as Record<string, unknown>)
      : undefined;

  const nested = typeof ui?.resourceUri === "string" ? ui.resourceUri : undefined;
  const legacy =
    typeof meta?.["ui/resourceUri"] === "string"
      ? (meta["ui/resourceUri"] as string)
      : undefined;
  // The OpenAI Apps SDK's template key. A tool carrying only this renders in
  // ChatGPT and, depending on its visibility, may render nothing in Claude.
  const openAiTemplate =
    typeof meta?.["openai/outputTemplate"] === "string"
      ? (meta["openai/outputTemplate"] as string)
      : undefined;

  if (!nested && !legacy && !openAiTemplate) return undefined;

  return {
    name: tool.name,
    resourceUri: nested ?? legacy ?? openAiTemplate ?? "",
    hasNestedField: nested !== undefined,
    hasLegacyField: legacy !== undefined,
    toolMeta: meta,
    hasOpenAiWidget: openAiTemplate !== undefined,
  };
}

/**
 * Build resource evidence from one `resources/read` content entry.
 *
 * `html` is only populated for a text content whose mime type says HTML —
 * running the design lints over a blob of JSON would produce confident
 * nonsense.
 */
export function claudeAppResourceEvidenceFrom(content: {
  uri?: string;
  mimeType?: string;
  text?: string;
  _meta?: unknown;
}): ClaudeAppResourceEvidence {
  const meta =
    typeof content._meta === "object" &&
    content._meta !== null &&
    !Array.isArray(content._meta)
      ? (content._meta as Record<string, unknown>)
      : undefined;
  const ui =
    typeof meta?.ui === "object" && meta.ui !== null && !Array.isArray(meta.ui)
      ? (meta.ui as Record<string, unknown>)
      : undefined;

  const isHtml = (content.mimeType ?? "").toLowerCase().includes("text/html");

  return {
    uri: content.uri ?? "",
    mimeType: content.mimeType,
    domain: typeof ui?.domain === "string" ? ui.domain : undefined,
    csp:
      typeof ui?.csp === "object" && ui.csp !== null && !Array.isArray(ui.csp)
        ? (ui.csp as Record<string, unknown>)
        : undefined,
    html: isHtml && typeof content.text === "string" ? content.text : undefined,
    claimsSingleActiveInstance:
      ui?.singleActiveInstance === true || ui?.instances === "single",
  };
}
