/**
 * Tool-annotation checks.
 *
 * THE RULE IS PRESENCE, NOT VALUE. All three hints — `readOnlyHint`,
 * `destructiveHint`, `openWorldHint` — must be declared on every tool, and a
 * missing hint is not "assumed safe": it is unreviewable, and the directory
 * treats it that way. So this grades DECLARED-ness deterministically and never
 * second-guesses what was declared.
 *
 * WHETHER A DECLARATION IS HONEST is a different question and a different lane.
 * A tool named `delete_everything` claiming `readOnlyHint: true` is a strong
 * signal, and it is still only a signal: the check cannot execute the tool, and
 * a name is not a specification. It lands in experience-insights as a
 * `heuristic`, where it can never fail a lane — which is what keeps a
 * string-matching hunch out of a verdict a submitter is held to.
 *
 * The listing is STATIC evidence, not a wire observation: the runner reads it
 * once and hands it over, so nothing here dials anything.
 *
 * Pure data. No transport.
 */

import { openaiPolicySource } from "../manifest.js";
import {
  OPENAI_FIELD_LIMITS,
  OPENAI_REQUIRED_TOOL_ANNOTATIONS,
} from "../profile.js";
import {
  OPENAI_READINESS_INPUTS,
  type OpenAIReadinessFinding,
} from "../types.js";
import {
  informational,
  missingInput,
  notApplicable,
  notEvaluated,
  satisfied,
  violated,
  type OpenAICheckDefinition,
  type OpenAICheckStamp,
} from "./helpers.js";

/** The subset of a tool definition these checks read. */
export interface OpenAIToolEvidence {
  name: string;
  description?: string;
  annotations?: Record<string, unknown>;
  inputSchema?: unknown;
  outputSchema?: unknown;
  _meta?: Record<string, unknown>;
  /** Per-tool security schemes, when the server declares them. */
  securitySchemes?: unknown;
}

const ANNOTATIONS_PRESENT: OpenAICheckDefinition = {
  id: "openai.tools.annotations",
  title: "Every tool declares all three annotation hints",
  lane: "directory-policy",
  class: "required",
  source: openaiPolicySource("plan/tools", "§Annotations"),
  provenance: "static",
  intrusiveness: "passive",
};

const DESCRIPTIONS_PRESENT: OpenAICheckDefinition = {
  id: "openai.tools.descriptions",
  title: "Every tool declares a description",
  lane: "directory-policy",
  class: "required",
  source: openaiPolicySource("guides/optimize-metadata", "§Tool descriptions"),
  provenance: "static",
  intrusiveness: "passive",
};

const NAMES_WITHIN_LIMIT: OpenAICheckDefinition = {
  id: "openai.tools.name-length",
  title: "Every tool name is within the host's length limit",
  lane: "directory-policy",
  class: "required",
  source: openaiPolicySource("plan/tools", "§Naming"),
  provenance: "static",
  intrusiveness: "passive",
};

const SCHEMAS_VALID: OpenAICheckDefinition = {
  id: "openai.tools.schemas",
  title: "Every tool's input schema is a JSON Schema object",
  lane: "directory-policy",
  class: "required",
  source: openaiPolicySource("plan/tools", "§Schemas"),
  provenance: "static",
  intrusiveness: "passive",
};

const ANNOTATION_HONESTY: OpenAICheckDefinition = {
  id: "openai.tools.annotation-honesty",
  title: "Annotations look consistent with what the tools appear to do",
  lane: "experience-insights",
  class: "heuristic",
  source: openaiPolicySource("app-guidelines", "§Predictable side effects"),
  provenance: "static",
  intrusiveness: "passive",
};

const PER_TOOL_SECURITY: OpenAICheckDefinition = {
  id: "openai.tools.security-schemes",
  title: "Per-tool security schemes are declared where tools differ in access",
  lane: "directory-policy",
  class: "recommended",
  source: openaiPolicySource("build/auth", "§Per-tool authorization"),
  provenance: "static",
  intrusiveness: "passive",
};

const ALL: OpenAICheckDefinition[] = [
  ANNOTATIONS_PRESENT,
  DESCRIPTIONS_PRESENT,
  NAMES_WITHIN_LIMIT,
  SCHEMAS_VALID,
  ANNOTATION_HONESTY,
  PER_TOOL_SECURITY,
];

/**
 * Verbs that suggest a tool changes something.
 *
 * A HEURISTIC, and named as one. Its job is to raise a question for a reviewer,
 * not to answer it: plenty of read-only tools are called `update_view` and
 * plenty of destructive ones are called `apply`.
 *
 * A SET plus an explicit split, rather than one regex. The regex this replaced
 * used `\b` after each verb, and `_` is a word character — so `delete_account`,
 * the single most obvious case, never matched. Splitting the name into words
 * first is both correct and readable.
 */
const MUTATING_VERBS = new Set([
  "delete",
  "remove",
  "destroy",
  "drop",
  "purge",
  "revoke",
  "cancel",
  "refund",
  "send",
  "post",
  "publish",
  "create",
  "update",
  "write",
  "set",
  "modify",
  "patch",
  "move",
  "rename",
  "archive",
  "reset",
  "clear",
  "wipe",
]);

/** The first word of a tool name, in snake, kebab, dotted or camel case. */
function leadingVerb(name: string): string {
  return (
    name
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .split(/[_\-.\s/]+/)
      .filter(Boolean)[0] ?? ""
  );
}

function looksMutating(name: string): boolean {
  return MUTATING_VERBS.has(leadingVerb(name));
}

/** Tool names carrying a destructive or open-world annotation. */
export function annotatedToolNames(
  tools: readonly OpenAIToolEvidence[],
): string[] {
  return tools
    .filter(
      (tool) =>
        tool.annotations?.destructiveHint === true ||
        tool.annotations?.openWorldHint === true,
    )
    .map((tool) => tool.name)
    .sort();
}

/**
 * How the run came by its listing, and whether the listing is the whole one.
 *
 * A SECOND ARGUMENT rather than a field on each tool, because completeness is
 * a property of the LISTING and there is nowhere on an array to put it. Before
 * the gatherer dialled `tools/list` this distinction did not exist — a run
 * either held a listing a caller handed it or held nothing — and now a run can
 * hold five of forty tools. Grading those five as the set would report a
 * submission ready on the tools that fit on page one, which is precisely the
 * failure `incomplete` exists to make visible.
 */
export interface OpenAIToolListingCompleteness {
  /**
   * `false` only when the run KNOWS the listing is partial. `undefined` means
   * no claim was made — a caller-supplied listing, which the caller has
   * already decided about — and is treated as complete.
   */
  complete?: boolean;
  /** Why it is partial, for the gap's own sentence. */
  error?: string;
}

export function runOpenAIAnnotationChecks(
  tools: readonly OpenAIToolEvidence[] | undefined,
  stamp: OpenAICheckStamp,
  listing?: OpenAIToolListingCompleteness,
): OpenAIReadinessFinding[] {
  if (!tools) {
    // THE DIAL'S OWN REASON, when there is one. A `tools/list` that could not
    // be reached and a caller who simply supplied nothing produce the same
    // absent listing, and only the first has an explanation a submitter can
    // act on — "the server refused the request" sends them somewhere, "this
    // run was given no tool listing" sends them to us.
    const reason = listing?.error
      ? `${listing.error}, so no tool listing was available to grade`
      : "this run was given no tool listing";
    return ALL.map((definition) =>
      notEvaluated(
        definition,
        stamp,
        reason,
        missingInput(OPENAI_READINESS_INPUTS.toolListing),
      ),
    );
  }

  // A PARTIAL LISTING GRADES NOTHING. Not even the entries that did arrive:
  // every check here is universally quantified — "EVERY tool declares all
  // three hints" — and a universal claim over a subset is not a weaker claim,
  // it is a different one. Reporting `satisfied` from five of forty tools
  // would be a pass the run did not earn, and the tools that arrived are still
  // carried in the evidence for anyone who wants to look.
  if (listing?.complete === false) {
    const why =
      listing.error ??
      "the tool listing was truncated before the whole set was read";
    return ALL.map((definition) =>
      notEvaluated(
        definition,
        stamp,
        `${why}, so a requirement about every tool cannot be graded`,
        missingInput(OPENAI_READINESS_INPUTS.toolListing, {
          toolsRead: tools.length,
        }),
      ),
    );
  }

  if (tools.length === 0) {
    // A server with no tools is a real shape — a skills-only plugin's server,
    // or one that only serves resources — and it is not a coverage gap.
    return ALL.map((definition) =>
      notApplicable(definition, stamp, "the server advertises no tools"),
    );
  }

  const findings: OpenAIReadinessFinding[] = [];

  const missingHints = tools
    .map((tool) => ({
      name: tool.name,
      missing: OPENAI_REQUIRED_TOOL_ANNOTATIONS.filter(
        (hint) => typeof tool.annotations?.[hint] !== "boolean",
      ),
    }))
    .filter((entry) => entry.missing.length > 0);

  findings.push(
    missingHints.length === 0
      ? satisfied(ANNOTATIONS_PRESENT, stamp, { tools: tools.length })
      : violated(
          ANNOTATIONS_PRESENT,
          stamp,
          // An unannotated tool is unreviewable, not assumed safe.
          `Declare ${OPENAI_REQUIRED_TOOL_ANNOTATIONS.join(
            ", ",
          )} on every tool; these are missing hints: ${missingHints
            .map((entry) => `${entry.name} (${entry.missing.join(", ")})`)
            .join("; ")}.`,
          { missing: missingHints },
        ),
  );

  const undescribed = tools
    .filter((tool) => !tool.description || tool.description.trim().length === 0)
    .map((tool) => tool.name);
  findings.push(
    undescribed.length === 0
      ? satisfied(DESCRIPTIONS_PRESENT, stamp, { tools: tools.length })
      : violated(
          DESCRIPTIONS_PRESENT,
          stamp,
          `Describe every tool; these have no description: ${undescribed.join(
            ", ",
          )}.`,
          { undescribed },
        ),
  );

  const overLong = tools
    .filter((tool) => tool.name.length > OPENAI_FIELD_LIMITS.toolNameMaxLength)
    .map((tool) => tool.name);
  findings.push(
    overLong.length === 0
      ? satisfied(NAMES_WITHIN_LIMIT, stamp, {
          limit: OPENAI_FIELD_LIMITS.toolNameMaxLength,
        })
      : violated(
          NAMES_WITHIN_LIMIT,
          stamp,
          `Shorten these tool names to ${
            OPENAI_FIELD_LIMITS.toolNameMaxLength
          } characters or fewer: ${overLong.join(", ")}.`,
          { overLong },
        ),
  );

  const badSchemas = tools
    .filter(
      (tool) =>
        typeof tool.inputSchema !== "object" ||
        tool.inputSchema === null ||
        Array.isArray(tool.inputSchema),
    )
    .map((tool) => tool.name);
  findings.push(
    badSchemas.length === 0
      ? satisfied(SCHEMAS_VALID, stamp, { tools: tools.length })
      : violated(
          SCHEMAS_VALID,
          stamp,
          `Give every tool a JSON Schema object as its input schema; these do not have one: ${badSchemas.join(
            ", ",
          )}.`,
          { badSchemas },
        ),
  );

  // ------------------------------------------------------------- the heuristic
  const suspicious = tools
    .filter(
      (tool) =>
        tool.annotations?.readOnlyHint === true && looksMutating(tool.name),
    )
    .map((tool) => tool.name);
  findings.push(
    // `informational`, in experience-insights, as a `heuristic`. Three separate
    // guards against a name match failing somebody's submission.
    informational(
      ANNOTATION_HONESTY,
      stamp,
      { flagged: suspicious, tools: tools.length },
      suspicious.length === 0
        ? "No tool name contradicts its annotations, as far as a name can show."
        : `These tools are annotated read-only and named as though they change something: ${suspicious.join(
            ", ",
          )}. A name is not a specification — worth a look, not a verdict.`,
    ),
  );

  // ------------------------------------------------- per-tool security schemes
  const declared = tools.filter((tool) => tool.securitySchemes !== undefined);
  findings.push(
    declared.length > 0
      ? satisfied(PER_TOOL_SECURITY, stamp, {
          tools: declared.map((tool) => tool.name),
        })
      : informational(
          PER_TOOL_SECURITY,
          stamp,
          { tools: tools.length },
          "No tool declares its own security scheme. That is correct when every tool needs the same access, and worth revisiting when they do not.",
        ),
  );

  return findings;
}
