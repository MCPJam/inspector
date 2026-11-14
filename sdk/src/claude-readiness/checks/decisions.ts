/**
 * The decision questions a Claude run asks: does a sentence the direction
 * scan proposed tell Claude to call another tool, and does a tool's
 * description agree with its annotations. Pure. No transport.
 */

import {
  DIRECTORY_DECISION_CHECK,
  gradeDecisionAnswers,
  type DirectoryDecisionScan,
} from "../../directory-readiness/decisions/grade.js";
import { claudePolicySource } from "../manifest.js";
import {
  CLAUDE_READINESS_ENGINE_VERSION,
  type ClaudeReadinessFinding,
} from "../types.js";
import type { ClaudeCheckDefinition, ClaudeCheckStamp } from "./helpers.js";
import {
  CLAUDE_TOOL_LISTING_INPUT,
  type ClaudeToolListingCompleteness,
} from "./tools.js";

const CROSS_TOOL_DIRECTION: ClaudeCheckDefinition = {
  id: "claude.decision.cross-tool-direction",
  title: "A decision model finds no direction to call another tool",
  lane: "experience-insights",
  source: claudePolicySource("submission", "§Attestations → Tool descriptions"),
  ...DIRECTORY_DECISION_CHECK,
};

const ANNOTATIONS_MATCH_BEHAVIOUR: ClaudeCheckDefinition = {
  id: "both.decision.annotation-matches-behaviour",
  title: "A decision model finds descriptions agree with annotations",
  lane: "experience-insights",
  source: claudePolicySource("review-criteria", "§Tools → Annotations"),
  ...DIRECTORY_DECISION_CHECK,
};

export function runClaudeDecisionChecks(
  input: { decisionScan?: DirectoryDecisionScan; tools?: readonly unknown[] },
  stamp: ClaudeCheckStamp,
  listing?: ClaudeToolListingCompleteness
): ClaudeReadinessFinding[] {
  const scan = input.decisionScan;
  return gradeDecisionAnswers(scan?.items ?? [], scan?.answers ?? [], {
    confidenceThreshold: scan?.confidenceThreshold,
    unasked: scan?.unasked,
    checks: [CROSS_TOOL_DIRECTION, ANNOTATIONS_MATCH_BEHAVIOUR],
    engineVersion: CLAUDE_READINESS_ENGINE_VERSION,
    stamp,
    listing: { read: input.tools !== undefined, ...listing },
    missingInput: CLAUDE_TOOL_LISTING_INPUT,
  }).findings;
}
