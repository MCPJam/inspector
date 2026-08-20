/**
 * Tool-definition checks for the directory-policy lane.
 *
 * These are DETERMINISTIC reads of the tool list: a name is over 64 characters
 * or it is not, an annotation contradicts itself or it does not. Anything that
 * needs judgement about what a tool DOES — whether it moves money, whether its
 * description is honest — belongs to experience-insights, not here.
 *
 * The catch-all rule is the one that needed the most care, and it is
 * documented at {@link CATCH_ALL_TOOL} rather than in a summary line.
 *
 * Pure: takes a tool snapshot, returns findings. No transport, no client.
 */

import type { Tool } from "@modelcontextprotocol/client";

import { claudePolicySource } from "../manifest.js";
import { CLAUDE_SUBMISSION_LIMITS } from "../profile.js";
import type { ClaudeReadinessFinding } from "../types.js";
import {
  notApplicable,
  notEvaluated,
  satisfied,
  violated,
  type ClaudeCheckDefinition,
  type ClaudeCheckStamp,
} from "./helpers.js";

/**
 * The input that closes this module's coverage gap.
 *
 * A tool listing is not something a caller "has" — on an OAuth connector it
 * costs a completed authorization to get one. Naming it lets a surface tell
 * the submitter to authenticate rather than leaving the run-level summary to
 * offer whatever unrelated input happened to be declared elsewhere.
 */
export const CLAUDE_TOOL_LISTING_INPUT = "toolListing";

const TOOL_NAME_LENGTH: ClaudeCheckDefinition = {
  id: "claude.tools.name-length",
  title: "Tool names fit Claude's 64-character limit",
  lane: "directory-policy",
  class: "required",
  source: claudePolicySource("review-criteria", "§Tools → Naming"),
  provenance: "static",
  intrusiveness: "passive",
};

const TOOL_TITLE_PRESENT: ClaudeCheckDefinition = {
  id: "claude.tools.title-present",
  title: "Every tool carries a human-readable title",
  lane: "directory-policy",
  class: "required",
  source: claudePolicySource("review-criteria", "§Tools → Titles"),
  provenance: "static",
  intrusiveness: "passive",
};

const TOOL_HINTS_PRESENT: ClaudeCheckDefinition = {
  id: "claude.tools.behavior-hints-present",
  title: "Every tool declares its read/write behavior",
  lane: "directory-policy",
  class: "required",
  source: claudePolicySource("review-criteria", "§Tools → Annotations"),
  provenance: "static",
  intrusiveness: "passive",
};

const TOOL_HINTS_CONSISTENT: ClaudeCheckDefinition = {
  id: "claude.tools.behavior-hints-consistent",
  title: "No tool declares itself both read-only and destructive",
  lane: "directory-policy",
  class: "required",
  source: claudePolicySource("review-criteria", "§Tools → Annotations"),
  provenance: "static",
  intrusiveness: "passive",
};

const CATCH_ALL_TOOL: ClaudeCheckDefinition = {
  id: "claude.tools.no-catch-all-read-write",
  title: "No single tool exposes both safe and unsafe operations",
  lane: "directory-policy",
  class: "required",
  source: claudePolicySource("review-criteria", "§Tools → Scope"),
  provenance: "static",
  intrusiveness: "passive",
};

const CATCH_ALL_FREE_STRING: ClaudeCheckDefinition = {
  id: "claude.tools.free-string-operation-parameter",
  title: "No tool dispatches on an unconstrained operation string",
  lane: "experience-insights",
  // An ADVISORY, not a requirement. See the note on the check below: an
  // unconstrained string is a strong smell and not a demonstrated violation.
  class: "recommended",
  source: claudePolicySource("review-criteria", "§Tools → Scope"),
  provenance: "static",
  intrusiveness: "passive",
};

/**
 * Verbs that read, and verbs that change things.
 *
 * Deliberately short and unambiguous. A longer list catches more real cases
 * and also more false ones, and a false "this tool does both" accuses a
 * submitter of a disqualifying design flaw they do not have.
 */
const SAFE_VERBS = ["get", "list", "read", "search", "query", "fetch", "find"];
const UNSAFE_VERBS = [
  "create",
  "update",
  "delete",
  "write",
  "remove",
  "insert",
  "upsert",
  "send",
  "post",
  "put",
  "patch",
  "execute",
  "drop",
];

/** Parameter names that conventionally select an operation. */
const DISPATCH_PARAMETER_NAMES = [
  "method",
  "action",
  "operation",
  "op",
  "command",
  "verb",
];

interface SchemaLike {
  type?: unknown;
  enum?: unknown;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

function asSchema(value: unknown): SchemaLike | undefined {
  return typeof value === "object" && value !== null
    ? (value as SchemaLike)
    : undefined;
}

function matchesVerb(value: string, verbs: string[]): boolean {
  const normalized = value.toLowerCase();
  return verbs.some(
    (verb) =>
      normalized === verb ||
      normalized.startsWith(`${verb}_`) ||
      normalized.startsWith(`${verb}-`) ||
      // `getUser`, `createOrder` — camelCase, but only at the START, so
      // `budget` does not match `get` and `deleted_at` does not match
      // `delete`. A direct character test rather than a `new RegExp` built on
      // every comparison.
      (normalized.startsWith(verb) &&
        /[A-Z]/.test(value.charAt(verb.length))),
  );
}

/**
 * A tool whose schema DEMONSTRABLY accepts both a safe and an unsafe verb.
 *
 * "Demonstrably" is the whole rule, and it is narrow on purpose. The only
 * evidence that settles this from a schema alone is an ENUMERATED set of
 * operations containing verbs from both sides: the server has itself written
 * down that this one tool does `list` and `delete`. Anything looser — a
 * free-string `method`, a name like `manage_records`, a description that
 * mentions deleting — is a guess, and a hard failure built on a guess tells a
 * submitter to redesign their API on our hunch.
 *
 * The free-string case is not dropped; it becomes an advisory (see
 * {@link CATCH_ALL_FREE_STRING}), which is where a strong smell belongs.
 */
function demonstrableVerbs(
  tool: Tool,
): { parameter: string; safe: string[]; unsafe: string[] } | undefined {
  const properties = asSchema(tool.inputSchema)?.properties;
  if (!properties) return undefined;

  for (const [parameter, rawSchema] of Object.entries(properties)) {
    const schema = asSchema(rawSchema);
    const values = schema?.enum;
    if (!Array.isArray(values)) continue;
    const strings = values.filter(
      (value): value is string => typeof value === "string",
    );
    const safe = strings.filter((value) => matchesVerb(value, SAFE_VERBS));
    const unsafe = strings.filter((value) => matchesVerb(value, UNSAFE_VERBS));
    if (safe.length > 0 && unsafe.length > 0) {
      return { parameter, safe, unsafe };
    }
  }
  return undefined;
}

/** An unconstrained string parameter whose NAME says it selects an operation. */
function freeStringDispatch(tool: Tool): string | undefined {
  const properties = asSchema(tool.inputSchema)?.properties;
  if (!properties) return undefined;
  for (const [parameter, rawSchema] of Object.entries(properties)) {
    const schema = asSchema(rawSchema);
    if (
      DISPATCH_PARAMETER_NAMES.includes(parameter.toLowerCase()) &&
      schema?.type === "string" &&
      !Array.isArray(schema.enum)
    ) {
      return parameter;
    }
  }
  return undefined;
}

/**
 * The tool's display name, in the precedence MCP defines: top-level `title`,
 * then `annotations.title`, then the raw `name` (which the caller handles).
 */
function toolTitle(tool: Tool): string | undefined {
  const fromTool = (tool as { title?: unknown }).title;
  if (typeof fromTool === "string") return fromTool;
  const annotations = tool.annotations as { title?: unknown } | undefined;
  return typeof annotations?.title === "string" ? annotations.title : undefined;
}

function behaviorHints(tool: Tool): {
  readOnly?: boolean;
  destructive?: boolean;
} {
  const annotations = tool.annotations as
    | { readOnlyHint?: unknown; destructiveHint?: unknown }
    | undefined;
  return {
    readOnly:
      typeof annotations?.readOnlyHint === "boolean"
        ? annotations.readOnlyHint
        : undefined,
    destructive:
      typeof annotations?.destructiveHint === "boolean"
        ? annotations.destructiveHint
        : undefined,
  };
}

/**
 * Run every tool check.
 *
 * A server with no tools gets `not-applicable` rather than a clean pass: there
 * is nothing to grade, and reporting five satisfied requirements over an empty
 * list would be five statements about nothing.
 */
/**
 * How the run came by its listing, and whether the listing is the whole one.
 *
 * A SECOND ARGUMENT rather than a field on each tool, because completeness is
 * a property of the LISTING and there is nowhere on an array to put it. The
 * distinction only became reachable when the gatherer started dialling
 * `tools/list` itself: a run can now hold five of forty tools, and every check
 * below is universally quantified over "every tool".
 */
export interface ClaudeToolListingCompleteness {
  /**
   * `false` only when the run KNOWS the listing is partial. `undefined` means
   * no claim was made — a caller-supplied listing, which the caller has
   * already decided about — and is treated as complete.
   */
  complete?: boolean;
  /** Why it is partial, for the gap's own sentence. */
  error?: string;
}

export function runClaudeToolChecks(
  tools: Tool[] | undefined,
  stamp: ClaudeCheckStamp,
  listing?: ClaudeToolListingCompleteness,
): ClaudeReadinessFinding[] {
  const definitions = [
    TOOL_NAME_LENGTH,
    TOOL_TITLE_PRESENT,
    TOOL_HINTS_PRESENT,
    TOOL_HINTS_CONSISTENT,
    CATCH_ALL_TOOL,
    CATCH_ALL_FREE_STRING,
  ];

  // THESE TWO ARE NOT THE SAME THING, and collapsing them is how a coverage
  // gap gets reported as a clean lane. A server that advertises no tools has
  // nothing that could violate a tool requirement — genuinely inapplicable. A
  // run that never captured the listing has an untested obligation, and saying
  // "not applicable" there would claim we established something we never
  // looked at.
  if (!tools) {
    return definitions.map((definition) =>
      notEvaluated(
        definition,
        stamp,
        "no tool listing was captured for this run",
        // NAMING THE INPUT IS WHAT MAKES THE GAP ACTIONABLE. Without it the
        // run-level summary can only offer inputs some OTHER check declared,
        // and on an OAuth connector the only one left is `intrusive` — so a
        // server whose sole problem is "we could not authenticate" got told to
        // run the one probe that must never be aimed at someone else's
        // production server.
        { missingInput: CLAUDE_TOOL_LISTING_INPUT },
      ),
    );
  }
  // A PARTIAL LISTING GRADES NOTHING — not even the entries that did arrive.
  // Every check here is universally quantified ("every tool declares a
  // title"), and a universal claim over a subset is not a weaker claim, it is
  // a different one. The tools that arrived stay in the evidence for anyone
  // who wants to look; what they must not do is earn a pass for the ones that
  // did not.
  if (listing?.complete === false) {
    const why =
      listing.error ??
      "the tool listing was truncated before the whole set was read";
    return definitions.map((definition) =>
      notEvaluated(
        definition,
        stamp,
        `${why}, so a requirement about every tool cannot be graded`,
        { missingInput: CLAUDE_TOOL_LISTING_INPUT, toolsRead: tools.length },
      ),
    );
  }

  if (tools.length === 0) {
    return definitions.map((definition) =>
      notApplicable(
        definition,
        stamp,
        "the server advertises no tools, so there is nothing to grade",
      ),
    );
  }

  const findings: ClaudeReadinessFinding[] = [];

  const overlong = tools.filter(
    (tool) => tool.name.length > CLAUDE_SUBMISSION_LIMITS.toolNameMaxLength,
  );
  findings.push(
    overlong.length === 0
      ? satisfied(TOOL_NAME_LENGTH, stamp, { toolCount: tools.length })
      : violated(
          TOOL_NAME_LENGTH,
          stamp,
          `Shorten these tool names to ${CLAUDE_SUBMISSION_LIMITS.toolNameMaxLength} characters or fewer.`,
          { tools: overlong.map((tool) => tool.name) },
        ),
  );

  const untitled = tools.filter((tool) => !toolTitle(tool)?.trim());
  findings.push(
    untitled.length === 0
      ? satisfied(TOOL_TITLE_PRESENT, stamp)
      : violated(
          TOOL_TITLE_PRESENT,
          stamp,
          "Give each tool a `title` (or `annotations.title`) — Claude shows it to users in place of the raw tool name.",
          { tools: untitled.map((tool) => tool.name) },
        ),
  );

  const unhinted = tools.filter((tool) => {
    const hints = behaviorHints(tool);
    return hints.readOnly === undefined && hints.destructive === undefined;
  });
  findings.push(
    unhinted.length === 0
      ? satisfied(TOOL_HINTS_PRESENT, stamp)
      : violated(
          TOOL_HINTS_PRESENT,
          stamp,
          "Set `annotations.readOnlyHint` or `annotations.destructiveHint` on each tool so Claude can tell which calls need confirmation.",
          { tools: unhinted.map((tool) => tool.name) },
        ),
  );

  // Presence and CONSISTENCY are separate checks. A tool can carry both hints
  // and still be self-contradictory, and collapsing the two would let a
  // contradiction pass as "annotated".
  const contradictory = tools.filter((tool) => {
    const hints = behaviorHints(tool);
    return hints.readOnly === true && hints.destructive === true;
  });
  findings.push(
    contradictory.length === 0
      ? satisfied(TOOL_HINTS_CONSISTENT, stamp)
      : violated(
          TOOL_HINTS_CONSISTENT,
          stamp,
          "A tool cannot be both read-only and destructive; clear whichever hint is wrong.",
          { tools: contradictory.map((tool) => tool.name) },
        ),
  );

  const catchAll = tools
    .map((tool) => ({ tool, evidence: demonstrableVerbs(tool) }))
    .filter(
      (entry): entry is { tool: Tool; evidence: NonNullable<typeof entry.evidence> } =>
        entry.evidence !== undefined,
    );
  findings.push(
    catchAll.length === 0
      ? satisfied(CATCH_ALL_TOOL, stamp)
      : violated(
          CATCH_ALL_TOOL,
          stamp,
          "Split these tools so a single call cannot be either a read or a write — Claude's confirmation model annotates whole tools, not individual arguments.",
          {
            tools: catchAll.map((entry) => ({
              name: entry.tool.name,
              parameter: entry.evidence.parameter,
              safeValues: entry.evidence.safe,
              unsafeValues: entry.evidence.unsafe,
            })),
          },
        ),
  );

  const freeString = tools
    .map((tool) => ({ tool, parameter: freeStringDispatch(tool) }))
    .filter(
      (entry): entry is { tool: Tool; parameter: string } =>
        entry.parameter !== undefined,
    );
  findings.push(
    freeString.length === 0
      ? satisfied(CATCH_ALL_FREE_STRING, stamp)
      : violated(
          CATCH_ALL_FREE_STRING,
          stamp,
          "Constrain these operation parameters to an enum. As an open string, neither Claude nor this check can tell whether the tool performs a safe or an unsafe action.",
          {
            tools: freeString.map((entry) => ({
              name: entry.tool.name,
              parameter: entry.parameter,
            })),
          },
        ),
  );

  return findings;
}
