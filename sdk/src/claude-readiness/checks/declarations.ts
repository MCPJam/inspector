/**
 * The submission's declarations: the read/write answer held against the
 * tools' annotations, and whether anybody stood behind each declaration.
 *
 * The portal says of its read/write question "Based on what your tools do;
 * we check it against their annotations", so a mismatch is a requirement.
 * The portal also preselects answers and submits them if nobody looks.
 * Asking for a confirmation of those is MCPJam's own check, and it says so.
 *
 * Pure. No transport.
 */

import type { Tool } from "@modelcontextprotocol/client";

import { CLAUDE_CONNECTOR_FLOW } from "../../directory-readiness/flows/claude-connector.js";
import { directoryFlowField } from "../../directory-readiness/flows/fields.js";
import type { DirectoryUnconfirmedDeclaration } from "../../directory-readiness/flows/types.js";
import type { ClaudeAnswerEvidence } from "../answers.js";
import { claudePolicySource } from "../manifest.js";
import type { ClaudeReadinessFinding } from "../types.js";
import {
  notApplicable,
  notEvaluated,
  satisfied,
  violated,
  type ClaudeCheckDefinition,
  type ClaudeCheckStamp,
} from "./helpers.js";
import {
  CLAUDE_TOOL_LISTING_INPUT,
  type ClaudeToolListingCompleteness,
} from "./tools.js";

const ACCESS_MATCHES_ANNOTATIONS: ClaudeCheckDefinition = {
  id: "claude.submission.access-matches-annotations",
  title: "The read/write answer matches the tools' annotations",
  lane: "submission-artifacts",
  class: "required",
  source: claudePolicySource("submission", "§Use cases → Read/write"),
  provenance: "static",
  intrusiveness: "passive",
};

const DECLARATIONS_CONFIRMED: ClaudeCheckDefinition = {
  id: "claude.submission.declarations-confirmed",
  title: "Declarations are confirmed, not portal defaults (MCPJam check)",
  lane: "submission-artifacts",
  class: "manual-review",
  source: claudePolicySource("submission", "§Data handling"),
  provenance: "declared",
  intrusiveness: "passive",
};

const ACCESS_KEY = "useCases.access";
/** Tool names a sentence lists before "and N more". */
const NAMES_IN_TEXT = 10;
/** Tool names a finding's details keep. */
const NAMES_IN_DETAILS = 50;
export const NO_ANSWERS =
  "this check reads a connector submission's answers, and this run had none";

export interface ClaudeDeclarationEvidence {
  answers?: ClaudeAnswerEvidence;
  tools?: Tool[];
  listing?: ClaudeToolListingCompleteness;
}

export function runClaudeDeclarationChecks(
  evidence: ClaudeDeclarationEvidence,
  stamp: ClaudeCheckStamp
): ClaudeReadinessFinding[] {
  return [
    accessFinding(evidence, stamp),
    confirmedFinding(evidence.answers, stamp),
  ];
}

function accessFinding(
  { answers, tools, listing }: ClaudeDeclarationEvidence,
  stamp: ClaudeCheckStamp
): ClaudeReadinessFinding {
  const definition = ACCESS_MATCHES_ANNOTATIONS;
  if (!answers) return notEvaluated(definition, stamp, NO_ANSWERS);
  const field = directoryFlowField(CLAUDE_CONNECTOR_FLOW, ACCESS_KEY);
  const label = field?.label ?? ACCESS_KEY;
  const option = field?.options?.find(
    (entry) => entry.value === answers.values[ACCESS_KEY]
  );
  if (!option) {
    return notEvaluated(
      definition,
      stamp,
      `${label} has no answer the portal offers, so there is nothing to compare with the tools' annotations`,
      { missingInput: ACCESS_KEY }
    );
  }
  if (!tools || listing?.complete === false) {
    return notEvaluated(
      definition,
      stamp,
      tools
        ? `${listing?.error ?? "the tool listing was truncated before the whole set was read"}, so the answer cannot be compared with every tool`
        : "no tool listing was captured for this run",
      { missingInput: CLAUDE_TOOL_LISTING_INPUT, declared: option.value }
    );
  }
  if (tools.length === 0) {
    return notApplicable(
      definition,
      stamp,
      "the server advertises no tools, so there are no annotations to compare"
    );
  }

  // MCP's default for an absent `readOnlyHint` is false, so only an
  // explicit `true` says a tool never writes.
  const readOnly = tools.filter(isReadOnly).map((tool) => tool.name);
  const writing = tools
    .filter((tool) => !isReadOnly(tool))
    .map((tool) => tool.name);
  const origin = answers.origins[ACCESS_KEY];
  const said = `${label} ${origin === "default" ? "is still the portal's default," : "says"} ${option.label}`;
  const optionLabel = (value: string) =>
    field?.options?.find((entry) => entry.value === value)?.label ?? value;
  /** "64 of 135 tools are" */
  const someOf = (count: number) =>
    `${count} of ${tools.length} ${tools.length === 1 ? "tool" : "tools"} ${count === 1 ? "is" : "are"}`;
  const details = {
    declared: option.value,
    origin,
    tools: tools.length,
    readOnly: readOnly.length,
  };

  if (option.value === "read-only" && writing.length > 0) {
    return violated(
      definition,
      stamp,
      `${said}, but ${someOf(writing.length)} not annotated readOnlyHint: true: ${nameList(writing)}. Choose ${optionLabel("read-write")} on the Use cases step, or set readOnlyHint: true on the tools that only read.`,
      {
        ...details,
        notReadOnly: writing.slice(0, NAMES_IN_DETAILS),
        notReadOnlyCount: writing.length,
      }
    );
  }
  if (option.value === "write-only" && readOnly.length > 0) {
    return violated(
      definition,
      stamp,
      `${said}, but ${someOf(readOnly.length)} annotated readOnlyHint: true: ${nameList(readOnly)}. Choose ${optionLabel("read-write")} on the Use cases step, or correct those annotations.`,
      { ...details, readOnlyTools: readOnly.slice(0, NAMES_IN_DETAILS) }
    );
  }
  if (option.value === "read-write" && writing.length === 0) {
    return violated(
      definition,
      stamp,
      `${said}, but every tool is annotated readOnlyHint: true. Choose ${optionLabel("read-only")} on the Use cases step, or correct the annotations on the tools that write.`,
      details
    );
  }
  return satisfied(definition, stamp, details);
}

function isReadOnly(tool: Tool): boolean {
  const annotations = tool.annotations as
    { readOnlyHint?: unknown } | undefined;
  return annotations?.readOnlyHint === true;
}

/** "a, b, c and 61 more" */
function nameList(names: readonly string[]): string {
  const shown = names.slice(0, NAMES_IN_TEXT).join(", ");
  const rest = names.length - NAMES_IN_TEXT;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

function confirmedFinding(
  answers: ClaudeAnswerEvidence | undefined,
  stamp: ClaudeCheckStamp
): ClaudeReadinessFinding {
  const definition = DECLARATIONS_CONFIRMED;
  if (!answers) return notEvaluated(definition, stamp, NO_ANSWERS);
  const { unconfirmed } = answers;
  if (unconfirmed.length === 0) return satisfied(definition, stamp);
  const one = unconfirmed.length === 1;
  return violated(
    definition,
    stamp,
    `Nobody has confirmed ${one ? "1 declaration" : `${unconfirmed.length} declarations`}, so the portal would submit ${one ? "it as it stands" : "them as they stand"}. Confirm or change each on its step: ${unconfirmed.map(describeUnconfirmed).join(", ")}. This is an MCPJam check; the portal accepts its own defaults.`,
    { unconfirmed, unconfirmedCount: unconfirmed.length }
  );
}

export function describeUnconfirmed(
  entry: DirectoryUnconfirmedDeclaration
): string {
  switch (entry.origin) {
    case undefined:
      return `${entry.label} (no answer)`;
    case "default": {
      const option = directoryFlowField(
        CLAUDE_CONNECTOR_FLOW,
        entry.key
      )?.options?.find((candidate) => candidate.value === entry.value);
      return `${entry.label} (the portal's default, ${option?.label ?? String(entry.value)})`;
    }
    case "account":
      return `${entry.label} (filled from your account)`;
    case "confirmed":
      return `${entry.label} (confirmed before its wording changed)`;
    default:
      return `${entry.label} (${entry.origin})`;
  }
}
