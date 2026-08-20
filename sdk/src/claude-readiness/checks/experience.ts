/**
 * The experience-insights lane: what a reviewer should look at, never a
 * verdict.
 *
 * EVERY FINDING IN THIS MODULE IS ADVISORY BY CONSTRUCTION. The classes here
 * are `heuristic` and `manual-review`, and neither can move a required lane —
 * `decideLaneStatus` only reads `required` and `runtime-blocker`. That is not
 * a convention to be careful about; it is what makes it safe to ship checks
 * whose evidence is suggestive rather than dispositive.
 *
 * WHY THAT MATTERS MORE HERE THAN ANYWHERE ELSE. These are the checks with no
 * rule behind them. Anthropic does not publish a maximum tool count or a
 * minimum description length, and there is no threshold at which a connector
 * becomes un-listable for either. What there IS, is a well-understood failure
 * mode: a model choosing between forty near-identically named tools picks
 * wrong, and the person blames the connector. Saying that out loud is useful;
 * turning it into a pass/fail would be inventing policy Anthropic never wrote,
 * which is exactly what the finding-class vocabulary exists to prevent.
 *
 * The browser checks below carry `requiresCapabilities: ["browser"]` and are
 * therefore `not-evaluated` on every wire-only run. That is the honest
 * reporting of a gap, not a stub: the check is defined, its coverage is
 * counted, and the lane says a browser would close it. A run that silently
 * omitted them would report the same lane as fully covered.
 */

import type { Tool } from "@modelcontextprotocol/client";
import { claudePolicySource } from "../manifest.js";
import type { ClaudeReadinessFinding } from "../types.js";
import {
  informational,
  notApplicable,
  notEvaluated,
  satisfied,
  violated,
  type ClaudeCheckDefinition,
  type ClaudeCheckStamp,
} from "./helpers.js";
import { CLAUDE_TOOL_LISTING_INPUT } from "./tools.js";

/**
 * Thresholds, named so the remediation text can quote them.
 *
 * Every one is a JUDGEMENT and is documented as such. Anthropic publishes none
 * of these numbers, so a finding that cited "the limit" would be citing us.
 * The remediations say "beyond about N" for that reason.
 */
export const CLAUDE_EXPERIENCE_BUDGETS = {
  /**
   * Where a flat tool list stops being one a model can choose from reliably.
   * Chosen to sit well above ordinary connectors (a dozen or two) and below
   * the API-surface dumps where selection demonstrably degrades.
   */
  toolCountSmell: 40,
  /**
   * A description shorter than this cannot say what a tool does, when to use
   * it, or what it returns. Deliberately small — the check is aimed at
   * placeholders, not at terse-but-real prose.
   */
  minDescriptionChars: 20,
} as const;

const TOOL_DESCRIPTIONS_USEFUL: ClaudeCheckDefinition = {
  id: "claude.experience.tool-descriptions-useful",
  title: "Tool descriptions say more than the tool's own name",
  lane: "experience-insights",
  class: "heuristic",
  source: claudePolicySource("review-criteria", "§Tools → Descriptions"),
  provenance: "static",
  intrusiveness: "passive",
};

const TOOL_NAMES_DISTINCT: ClaudeCheckDefinition = {
  id: "claude.experience.tool-names-distinct",
  title: "No two tools collapse to the same name",
  lane: "experience-insights",
  class: "heuristic",
  source: claudePolicySource("review-criteria", "§Tools → Naming"),
  provenance: "static",
  intrusiveness: "passive",
};

const TOOL_SURFACE_SIZE: ClaudeCheckDefinition = {
  id: "claude.experience.tool-surface-size",
  title: "The tool surface is small enough to choose from",
  lane: "experience-insights",
  class: "heuristic",
  source: claudePolicySource("review-criteria", "§Tools → Scope"),
  provenance: "static",
  intrusiveness: "passive",
};

const REQUIRED_PARAMS_GUIDED: ClaudeCheckDefinition = {
  id: "claude.experience.required-params-guided",
  title: "Required parameters say what a valid value looks like",
  lane: "experience-insights",
  class: "heuristic",
  source: claudePolicySource("review-criteria", "§Tools → Schemas"),
  provenance: "static",
  intrusiveness: "passive",
};

// ── Browser-quality ─────────────────────────────────────────────────────
//
// Defined here, evaluated only by a run that has a browser. On a wire-only run
// each becomes `not-evaluated` with the capability named, which is what keeps
// the lane's coverage honest: three checks that were never run are three
// checks the lane reports as not run, rather than three checks nobody knows
// about.

const WIDGET_CONSOLE_CLEAN: ClaudeCheckDefinition = {
  id: "claude.experience.widget-console-clean",
  title: "A widget renders without console errors",
  lane: "experience-insights",
  class: "heuristic",
  source: claudePolicySource("mcp-apps/troubleshooting", "§Debugging"),
  provenance: "browser",
  requiresCapabilities: ["browser"],
};

const WIDGET_FITS_NARROW: ClaudeCheckDefinition = {
  id: "claude.experience.widget-fits-narrow-viewport",
  title: "A widget fits Claude's narrowest surface without clipping",
  lane: "experience-insights",
  class: "heuristic",
  source: claudePolicySource("mcp-apps/design-guidelines", "§Responsive"),
  provenance: "browser",
  requiresCapabilities: ["browser"],
};

const WIDGET_PAINTS: ClaudeCheckDefinition = {
  id: "claude.experience.widget-paints",
  title: "A widget paints something rather than staying blank",
  lane: "experience-insights",
  // MANUAL REVIEW, not heuristic, and the distinction is real: a blank frame
  // may be a broken widget or a widget correctly waiting for data this harness
  // never supplied. A machine cannot tell those apart, so it reports what it
  // saw and asks a person.
  class: "manual-review",
  source: claudePolicySource("mcp-apps/design-guidelines", "§Loading"),
  provenance: "browser",
  requiresCapabilities: ["browser"],
};

/** What a browser run observed, when there was one. */
export interface ClaudeBrowserEvidence {
  /** One entry per widget the harness rendered. */
  widgets?: {
    uri: string;
    consoleErrors: string[];
    /** Rendered content width at the narrow viewport, in CSS pixels. */
    contentWidthPx?: number;
    /** The narrow viewport the harness used, in CSS pixels. */
    viewportWidthPx?: number;
    /** Whether anything was painted at all. */
    painted?: boolean;
  }[];
}

export interface ClaudeExperienceEvidence {
  tools?: Tool[];
  browser?: ClaudeBrowserEvidence;
}

/**
 * Normalize a tool name to what a model is likely to conflate.
 *
 * Case and separators only. Deliberately NOT stemming or synonyms: `get_user`
 * and `fetch_user` are different names that a reader can tell apart, and
 * flagging them would bury the pair that genuinely collide.
 */
function collapseName(name: string): string {
  return name.toLowerCase().replace(/[-_\s.]/g, "");
}

/** A description that only restates the name tells a model nothing new. */
function describesMoreThanItsName(tool: Tool): boolean {
  const description = (tool.description ?? "").trim();
  if (description.length < CLAUDE_EXPERIENCE_BUDGETS.minDescriptionChars) {
    return false;
  }
  // A description that IS the name, modulo separators and case.
  return collapseName(description) !== collapseName(tool.name);
}

function requiredPropertiesOf(tool: Tool): {
  name: string;
  schema: Record<string, unknown>;
}[] {
  const schema = tool.inputSchema as Record<string, unknown> | undefined;
  const required = Array.isArray(schema?.required)
    ? (schema.required as unknown[]).filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  const properties =
    schema?.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, unknown>)
      : {};
  return required.flatMap((name) => {
    const property = properties[name];
    return property && typeof property === "object"
      ? [{ name, schema: property as Record<string, unknown> }]
      : [];
  });
}

/**
 * A required string parameter a model has to guess at.
 *
 * "Guess at" is the whole test: an `enum`, a `format`, a `pattern`, an
 * example, or a description all give the model something to go on. Only a bare
 * `{"type": "string"}` leaves it inventing a value, and that is the case worth
 * a reviewer's attention.
 */
function isUnguidedStringParam(schema: Record<string, unknown>): boolean {
  if (schema.type !== "string") return false;
  return !(
    Array.isArray(schema.enum) ||
    typeof schema.format === "string" ||
    typeof schema.pattern === "string" ||
    typeof schema.description === "string" ||
    schema.examples !== undefined ||
    schema.default !== undefined
  );
}

const TOOL_DEFINITIONS = [
  TOOL_DESCRIPTIONS_USEFUL,
  TOOL_NAMES_DISTINCT,
  TOOL_SURFACE_SIZE,
  REQUIRED_PARAMS_GUIDED,
];

const BROWSER_DEFINITIONS = [
  WIDGET_CONSOLE_CLEAN,
  WIDGET_FITS_NARROW,
  WIDGET_PAINTS,
];

export function runClaudeExperienceChecks(
  evidence: ClaudeExperienceEvidence,
  stamp: ClaudeCheckStamp,
): ClaudeReadinessFinding[] {
  return [
    ...toolHeuristics(evidence.tools, stamp),
    ...browserQuality(evidence.browser, stamp),
  ];
}

function toolHeuristics(
  tools: Tool[] | undefined,
  stamp: ClaudeCheckStamp,
): ClaudeReadinessFinding[] {
  // The same three-way split the required tool checks make, and for the same
  // reason: "we never got a listing" and "there are no tools" are different
  // facts, and collapsing either into a pass would be a claim about something
  // nobody looked at.
  if (!tools) {
    return TOOL_DEFINITIONS.map((definition) =>
      notEvaluated(definition, stamp, "no tool listing was captured for this run", {
        missingInput: CLAUDE_TOOL_LISTING_INPUT,
      }),
    );
  }
  if (tools.length === 0) {
    return TOOL_DEFINITIONS.map((definition) =>
      notApplicable(
        definition,
        stamp,
        "the server advertises no tools, so there is nothing to weigh",
      ),
    );
  }

  const findings: ClaudeReadinessFinding[] = [];

  const undescribed = tools
    .filter((tool) => !describesMoreThanItsName(tool))
    .map((tool) => tool.name);
  findings.push(
    undescribed.length === 0
      ? satisfied(TOOL_DESCRIPTIONS_USEFUL, stamp)
      : violated(
          TOOL_DESCRIPTIONS_USEFUL,
          stamp,
          `Describe what each tool does, when to use it, and what it returns. Claude picks tools by reading these, so a name-shaped description is the one it will pick wrongly: ${undescribed.slice(0, 5).join(", ")}${undescribed.length > 5 ? ", …" : ""}.`,
          { tools: undescribed },
        ),
  );

  const byCollapsed = new Map<string, string[]>();
  for (const tool of tools) {
    const key = collapseName(tool.name);
    byCollapsed.set(key, [...(byCollapsed.get(key) ?? []), tool.name]);
  }
  const collisions = [...byCollapsed.values()].filter(
    (names) => names.length > 1,
  );
  findings.push(
    collisions.length === 0
      ? satisfied(TOOL_NAMES_DISTINCT, stamp)
      : violated(
          TOOL_NAMES_DISTINCT,
          stamp,
          `Rename one of each pair so the difference is a word rather than punctuation or case: ${collisions.map((names) => names.join(" / ")).join("; ")}.`,
          { collisions },
        ),
  );

  // INFORMATIONAL, not violated, even over budget. There is no published
  // ceiling, and a connector that genuinely needs sixty tools should not be
  // told it failed something — it should be told what the count costs.
  findings.push(
    tools.length > CLAUDE_EXPERIENCE_BUDGETS.toolCountSmell
      ? informational(
          TOOL_SURFACE_SIZE,
          stamp,
          { toolCount: tools.length },
          `This connector advertises ${tools.length} tools. Beyond about ${CLAUDE_EXPERIENCE_BUDGETS.toolCountSmell}, selection accuracy falls off — consider whether some belong behind fewer, better-described entry points.`,
        )
      : satisfied(TOOL_SURFACE_SIZE, stamp, { toolCount: tools.length }),
  );

  const unguided = tools.flatMap((tool) =>
    requiredPropertiesOf(tool)
      .filter((property) => isUnguidedStringParam(property.schema))
      .map((property) => `${tool.name}.${property.name}`),
  );
  findings.push(
    unguided.length === 0
      ? satisfied(REQUIRED_PARAMS_GUIDED, stamp)
      : violated(
          REQUIRED_PARAMS_GUIDED,
          stamp,
          `Give each of these a description, an enum, a format or an example. A required string with none of those leaves Claude inventing a value: ${unguided.slice(0, 5).join(", ")}${unguided.length > 5 ? ", …" : ""}.`,
          { parameters: unguided },
        ),
  );

  return findings;
}

function browserQuality(
  browser: ClaudeBrowserEvidence | undefined,
  stamp: ClaudeCheckStamp,
): ClaudeReadinessFinding[] {
  // THREE DIFFERENT FACTS, and each gets its own reason.
  //
  // The capability gate cannot fill any of these in: it deliberately refuses
  // to overwrite a finding that is already `not-evaluated`, so a reason
  // written here is the reason a reader sees. That makes naming the right one
  // this function's job, not the gate's.
  if (!browser) {
    return BROWSER_DEFINITIONS.map((definition) =>
      notEvaluated(
        definition,
        stamp,
        "this run had no browser, so no widget was rendered",
      ),
    );
  }
  const widgets = browser.widgets;
  if (!widgets) {
    // A browser WAS available and still reported nothing — a harness failure,
    // not a connector one, and saying so is what stops a submitter debugging
    // their widget over our problem.
    return BROWSER_DEFINITIONS.map((definition) =>
      notEvaluated(
        definition,
        stamp,
        "the browser harness reported no rendered widgets",
      ),
    );
  }
  if (widgets.length === 0) {
    return BROWSER_DEFINITIONS.map((definition) =>
      notApplicable(
        definition,
        stamp,
        "this connector declares no widgets, so there is nothing to render",
      ),
    );
  }

  const findings: ClaudeReadinessFinding[] = [];

  const noisy = widgets.filter((widget) => widget.consoleErrors.length > 0);
  findings.push(
    noisy.length === 0
      ? satisfied(WIDGET_CONSOLE_CLEAN, stamp)
      : violated(
          WIDGET_CONSOLE_CLEAN,
          stamp,
          `Fix the errors these widgets log on render — a console error is usually a feature that silently did not happen: ${noisy.map((widget) => widget.uri).join(", ")}.`,
          {
            widgets: noisy.map((widget) => ({
              uri: widget.uri,
              // Bounded: a widget in an error loop can log thousands, and the
              // first few are the ones that explain the rest.
              errors: widget.consoleErrors.slice(0, 5),
            })),
          },
        ),
  );

  // Only widgets the harness actually measured. A missing measurement is not
  // evidence of fitting.
  const measured = widgets.filter(
    (widget) =>
      typeof widget.contentWidthPx === "number" &&
      typeof widget.viewportWidthPx === "number",
  );
  const clipped = measured.filter(
    (widget) => widget.contentWidthPx! > widget.viewportWidthPx!,
  );
  findings.push(
    measured.length === 0
      ? notEvaluated(
          WIDGET_FITS_NARROW,
          stamp,
          "no widget reported a rendered width to compare against the viewport",
        )
      : clipped.length === 0
        ? satisfied(WIDGET_FITS_NARROW, stamp)
        : violated(
            WIDGET_FITS_NARROW,
            stamp,
            `These widgets overflow Claude's narrow surface, so part of them is unreachable: ${clipped.map((widget) => widget.uri).join(", ")}.`,
            {
              widgets: clipped.map((widget) => ({
                uri: widget.uri,
                contentWidthPx: widget.contentWidthPx,
                viewportWidthPx: widget.viewportWidthPx,
              })),
            },
          ),
  );

  const blank = widgets.filter((widget) => widget.painted === false);
  findings.push(
    blank.length === 0
      ? satisfied(WIDGET_PAINTS, stamp)
      : // INFORMATIONAL on a `manual-review` check: this reports what was seen
        // and hands the judgement to a person. A blank frame may be a broken
        // widget or one correctly waiting for data this harness never gave it,
        // and calling it `violated` would accuse a submitter of the first when
        // the evidence cannot rule out the second.
        informational(
          WIDGET_PAINTS,
          stamp,
          { widgets: blank.map((widget) => widget.uri) },
          `These widgets rendered nothing. Check whether they are broken, or waiting for data a real conversation would have supplied: ${blank.map((widget) => widget.uri).join(", ")}.`,
        ),
  );

  return findings;
}
