/**
 * The reviewer path a Claude submission run checks: who the reviewer account
 * is, the fixtures its test instructions name, and whether discovery answers
 * other client signatures. Pure. No transport.
 */

import type { DirectoryReviewerRunInput } from "../../directory-readiness/reviewer/evidence.js";
import { gradeDirectoryReviewerPath } from "../../directory-readiness/reviewer/grade.js";
import { claudePolicySource } from "../manifest.js";
import {
  CLAUDE_READINESS_ENGINE_VERSION,
  type ClaudeReadinessFinding,
} from "../types.js";
import type { ClaudeCheckDefinition, ClaudeCheckStamp } from "./helpers.js";

const REVIEWER_IDENTITY: ClaudeCheckDefinition = {
  id: "both.reviewer.identity",
  title:
    "The reviewer account is the intended reviewer, in the intended organization",
  lane: "submission-artifacts",
  class: "required",
  source: claudePolicySource("review-criteria", "§Test credentials"),
  provenance: "wire",
};

const REVIEWER_FIXTURES: ClaudeCheckDefinition = {
  id: "both.reviewer.fixtures",
  title: "The resources the test instructions name exist for the reviewer",
  lane: "submission-artifacts",
  class: "required",
  source: claudePolicySource("review-criteria", "§Test credentials"),
  provenance: "wire",
};

const CLIENT_SIGNATURES: ClaudeCheckDefinition = {
  id: "both.auth.client-signatures",
  title: "Discovery answers every common client signature",
  lane: "runtime-compatibility",
  class: "recommended",
  source: claudePolicySource("authentication", "§Discovery order"),
  provenance: "wire",
};

export function runClaudeReviewerChecks(
  input: DirectoryReviewerRunInput,
  stamp: ClaudeCheckStamp
): ClaudeReadinessFinding[] {
  return gradeDirectoryReviewerPath(
    input,
    {
      identity: REVIEWER_IDENTITY,
      fixtures: REVIEWER_FIXTURES,
      clientSignatures: CLIENT_SIGNATURES,
    },
    { engineVersion: CLAUDE_READINESS_ENGINE_VERSION, stamp }
  );
}
