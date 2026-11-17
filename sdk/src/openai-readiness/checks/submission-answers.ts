/** Grade the saved portal fields independently; package fields may not have been imported. */
import { CHATGPT_PLUGIN_FLOW } from "../../directory-readiness/flows/chatgpt-plugin.js";
import {
  directoryFlowField,
  unconfirmedDeclarations,
} from "../../directory-readiness/flows/fields.js";
import type { DirectoryAnswer } from "../../directory-readiness/flows/types.js";
import { validateDirectoryAnswers } from "../../directory-readiness/flows/validate.js";
import type { OpenAIReadinessFinding } from "../types.js";
import {
  notEvaluated,
  satisfied,
  violated,
  type OpenAICheckStamp,
} from "./helpers.js";

const FIELDS: Record<string, readonly string[]> = {
  "openai.submission.listing-fields": [
    "listing.displayName",
    "listing.shortDescription",
    "listing.description",
  ],
  "openai.submission.urls": ["listing.privacyPolicy", "listing.support"],
  "openai.submission.test-cases": [
    "reviewer.testCases",
    "reviewer.negativeTestCases",
  ],
  "openai.submission.demo-access": [
    "reviewer.loginUrl",
    "reviewer.username",
    "reviewer.passwordSecret",
    "reviewer.demoRecordingUrl",
  ],
  "openai.submission.attestations": ["submit.attestations"],
};

export function gradeOpenAISubmissionAnswers(
  findings: OpenAIReadinessFinding[],
  answers: readonly DirectoryAnswer[],
  stamp: OpenAICheckStamp,
): OpenAIReadinessFinding[] {
  const present = new Set(answers.map((answer) => answer.key));
  const issues = validateDirectoryAnswers(CHATGPT_PLUGIN_FLOW, answers, {
    on: "review",
  });
  const unconfirmed = unconfirmedDeclarations(CHATGPT_PLUGIN_FLOW, answers);
  return findings.map((finding) => {
    const keys = FIELDS[finding.id];
    if (!keys) {
      if (finding.id === "openai.submission.domain-token") {
        const token = answers.find(
          (answer) => answer.key === "mcp.verificationToken",
        )?.value;
        return typeof token === "string" && token.trim()
          ? satisfied(finding, stamp)
          : violated(
              finding,
              stamp,
              "Record the domain-verification token so the challenge can be checked.",
            );
      }
      return finding;
    }
    const knownIssues = issues.filter((issue) => {
      if (!keys.includes(issue.key)) return false;
      const field = directoryFlowField(CHATGPT_PLUGIN_FLOW, issue.key);
      return field?.managedBy !== "package" || present.has(issue.key);
    });
    const pending = unconfirmed.filter(
      (entry) => keys.includes(entry.key) && entry.origin !== undefined,
    );
    if (knownIssues.length || pending.length) {
      const lines = knownIssues.map((issue) => {
        const field = directoryFlowField(CHATGPT_PLUGIN_FLOW, issue.key);
        return `${field?.reviewLabel ?? field?.label ?? issue.key}: ${issue.message}`;
      });
      if (pending.length)
        lines.push(
          "Confirm the current attestation wording before submitting.",
        );
      return violated(finding, stamp, lines.join(" "), { issues: knownIssues });
    }
    const unknown = keys.filter(
      (key) =>
        directoryFlowField(CHATGPT_PLUGIN_FLOW, key)?.managedBy === "package" &&
        !present.has(key),
    );
    if (unknown.length) {
      return notEvaluated(
        finding,
        stamp,
        "Package values were not imported into this rehearsal, so these fields cannot be graded from the saved answers.",
        { missingInput: "package fields", fields: unknown },
      );
    }
    return satisfied(finding, stamp, { fields: keys });
  });
}
