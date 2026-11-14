/**
 * The decision questions an OpenAI run asks: does model-readable text steer
 * the choice of plugin, does it ask for secrets or protected context, and
 * does a tool's description agree with its annotations. Pure. No transport.
 */

import {
  DIRECTORY_DECISION_CHECK,
  gradeDecisionAnswers,
  type DirectoryDecisionScan,
} from "../../directory-readiness/decisions/grade.js";
import { openaiPolicySource } from "../manifest.js";
import {
  OPENAI_READINESS_ENGINE_VERSION,
  OPENAI_READINESS_INPUTS,
  type OpenAIReadinessFinding,
} from "../types.js";
import type { OpenAICheckDefinition, OpenAICheckStamp } from "./helpers.js";

const FAIR_PLAY: OpenAICheckDefinition = {
  id: "openai.decision.fair-play",
  title: "A decision model finds no text that steers the choice of plugin",
  lane: "experience-insights",
  source: openaiPolicySource("plugin-guidelines", "§Fair play"),
  ...DIRECTORY_DECISION_CHECK,
};

const SECRET_SEEKING: OpenAICheckDefinition = {
  id: "openai.decision.secret-seeking",
  title: "A decision model finds no text that asks for secrets",
  lane: "experience-insights",
  source: openaiPolicySource("plugin-guidelines", "§Metadata"),
  ...DIRECTORY_DECISION_CHECK,
};

const ANNOTATIONS_MATCH_BEHAVIOUR: OpenAICheckDefinition = {
  id: "both.decision.annotation-matches-behaviour",
  title: "A decision model finds descriptions agree with annotations",
  lane: "experience-insights",
  source: openaiPolicySource("plan/tools", "§Annotations"),
  ...DIRECTORY_DECISION_CHECK,
};

/** `listing` is absent when the submission has no MCP server to read. */
export function runOpenAIDecisionChecks(
  scan: DirectoryDecisionScan | undefined,
  stamp: OpenAICheckStamp,
  listing?: { read: boolean; complete?: boolean; error?: string }
): OpenAIReadinessFinding[] {
  return gradeDecisionAnswers(scan?.items ?? [], scan?.answers ?? [], {
    confidenceThreshold: scan?.confidenceThreshold,
    unasked: scan?.unasked,
    checks: [FAIR_PLAY, SECRET_SEEKING, ANNOTATIONS_MATCH_BEHAVIOUR],
    engineVersion: OPENAI_READINESS_ENGINE_VERSION,
    stamp,
    listing,
    missingInput: OPENAI_READINESS_INPUTS.toolListing,
  }).findings;
}
