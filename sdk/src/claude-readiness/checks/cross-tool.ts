/**
 * Candidate directions to another tool, for review.
 *
 * Claude's tool-descriptions acknowledgment rules out "instructions about
 * model behavior, other tools, or external instruction sources", and the
 * directory's compliance step flags descriptions that tell Claude to call
 * another tool. This proposes the sentences that read that way for a person
 * or the decision scan to judge: a heuristic, so it never fails a lane.
 *
 * Pure. No transport.
 */

import type { Tool } from "@modelcontextprotocol/client";

import { findToolDirectionCandidates } from "../../directory-readiness/tool-directions.js";
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

const CROSS_TOOL_DIRECTIONS: ClaudeCheckDefinition = {
  id: "claude.scan.cross-tool-direction-candidates",
  title: "No tool or parameter description tells Claude to call another tool",
  lane: "experience-insights",
  class: "heuristic",
  source: claudePolicySource("submission", "§Attestations → Tool descriptions"),
  provenance: "static",
  intrusiveness: "passive",
};

/** Candidates a finding keeps; `candidateCount` says how many there were. */
const CANDIDATES_KEPT = 25;

export function runClaudeCrossToolScan(
  tools: Tool[] | undefined,
  stamp: ClaudeCheckStamp,
  listing?: ClaudeToolListingCompleteness
): ClaudeReadinessFinding {
  const definition = CROSS_TOOL_DIRECTIONS;
  if (!tools || listing?.complete === false) {
    return notEvaluated(
      definition,
      stamp,
      tools
        ? `${listing?.error ?? "the tool listing was truncated before the whole set was read"}, so the scan cannot cover every tool`
        : "no tool listing was captured for this run",
      { missingInput: CLAUDE_TOOL_LISTING_INPUT }
    );
  }
  if (tools.length === 0) {
    return notApplicable(
      definition,
      stamp,
      "the server advertises no tools, so there is nothing to scan"
    );
  }
  const candidates = findToolDirectionCandidates(tools);
  if (candidates.length === 0) {
    return satisfied(definition, stamp, { toolsScanned: tools.length });
  }
  const one = candidates.length === 1;
  return violated(
    definition,
    stamp,
    `${one ? "1 sentence" : `${candidates.length} sentences`} in your tool descriptions ${one ? "reads" : "read"} as a direction to call another tool, which the tool descriptions acknowledgment rules out. Rewrite ${one ? "it" : "each"} as a fact about its own tool; a sentence that only names another tool can stay.`,
    {
      candidates: candidates.slice(0, CANDIDATES_KEPT),
      candidateCount: candidates.length,
      toolsScanned: tools.length,
    }
  );
}
