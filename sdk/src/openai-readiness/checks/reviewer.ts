/**
 * The reviewer path a ChatGPT submission run checks: who the reviewer account
 * is, the fixtures its test cases name, and whether discovery answers other
 * client signatures. Pure. No transport.
 */

import type { DirectoryReviewerRunInput } from "../../directory-readiness/reviewer/evidence.js";
import { gradeDirectoryReviewerPath } from "../../directory-readiness/reviewer/grade.js";
import { openaiPolicySource } from "../manifest.js";
import {
  OPENAI_READINESS_ENGINE_VERSION,
  type OpenAIReadinessFinding,
} from "../types.js";
import type { OpenAICheckDefinition, OpenAICheckStamp } from "./helpers.js";

const REVIEWER_IDENTITY: OpenAICheckDefinition = {
  id: "both.reviewer.identity",
  title:
    "The reviewer account is the intended reviewer, in the intended organization",
  lane: "submission-artifacts",
  class: "required",
  source: openaiPolicySource("deploy/submission", "§Demo access"),
  provenance: "wire",
};

const REVIEWER_FIXTURES: OpenAICheckDefinition = {
  id: "both.reviewer.fixtures",
  title: "The resources the test cases name exist for the reviewer",
  lane: "submission-artifacts",
  class: "required",
  source: openaiPolicySource("deploy/submission", "§Demo access"),
  provenance: "wire",
};

const CLIENT_SIGNATURES: OpenAICheckDefinition = {
  id: "both.auth.client-signatures",
  title: "Discovery answers every common client signature",
  lane: "runtime-compatibility",
  class: "recommended",
  source: openaiPolicySource("build/auth", "§Protected resource metadata"),
  provenance: "wire",
};

export function runOpenAIReviewerChecks(
  input: DirectoryReviewerRunInput,
  stamp: OpenAICheckStamp
): OpenAIReadinessFinding[] {
  return gradeDirectoryReviewerPath(
    input,
    {
      identity: REVIEWER_IDENTITY,
      fixtures: REVIEWER_FIXTURES,
      clientSignatures: CLIENT_SIGNATURES,
    },
    { engineVersion: OPENAI_READINESS_ENGINE_VERSION, stamp }
  );
}
