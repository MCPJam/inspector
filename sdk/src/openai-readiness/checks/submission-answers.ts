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
  notApplicable,
  satisfied,
  violated,
  type OpenAICheckStamp,
} from "./helpers.js";

const FIELDS: Record<string, readonly string[]> = {
  "openai.submission.listing-fields": [
    "listing.displayName",
    "listing.shortDescription",
    "listing.description",
    "listing.category",
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
  options: {
    hasPublishedVersion?: boolean;
    countries?: unknown;
    annotatedTools?: string[];
    frameDomains?: string[];
  } = {}
): OpenAIReadinessFinding[] {
  const present = new Set(answers.map((answer) => answer.key));
  const issues = validateDirectoryAnswers(CHATGPT_PLUGIN_FLOW, answers, {
    on: "review",
  });
  const unconfirmed = unconfirmedDeclarations(CHATGPT_PLUGIN_FLOW, answers);
  return findings.map((finding) => {
    if (
      finding.id === "openai.submission.geography" &&
      options.countries !== undefined
    ) {
      return Array.isArray(options.countries) &&
        options.countries.every(
          (country) => typeof country === "string" && /^[A-Z]{2}$/.test(country)
        )
        ? satisfied(
            {
              ...finding,
              title: "Country availability is declared in the package",
            },
            stamp,
            { countries: options.countries, packageDerived: true }
          )
        : violated(
            finding,
            stamp,
            "Use a list of uppercase country codes for package availability."
          );
    }
    const unused =
      finding.id === "openai.submission.annotation-justifications"
        ? options.annotatedTools
        : finding.id === "openai.submission.frame-domain-explanations"
          ? options.frameDomains
          : undefined;
    if (unused?.length === 0) {
      return notApplicable(
        finding,
        stamp,
        "No applicable tools or frame domains were observed in the supplied evidence."
      );
    }
    if (
      finding.id === "openai.submission.release-notes" &&
      options.hasPublishedVersion === false
    ) {
      return notApplicable(
        finding,
        stamp,
        "This is a first submission, so there is no previous version to describe."
      );
    }
    const keys =
      finding.id === "openai.submission.release-notes"
        ? ["reviewer.releaseNotes"]
        : FIELDS[finding.id];
    if (!keys) {
      if (finding.id === "openai.submission.domain-token") {
        const token = answers.find(
          (answer) => answer.key === "mcp.verificationToken"
        )?.value;
        return typeof token === "string" && token.trim()
          ? satisfied(finding, stamp)
          : violated(
              finding,
              stamp,
              "Record the domain-verification token so the challenge can be checked."
            );
      }
      const reason = ANSWER_GAPS[finding.id];
      return reason ? notEvaluated(finding, stamp, reason) : finding;
    }
    const knownIssues = issues.filter((issue) => {
      if (!keys.includes(issue.key)) return false;
      const field = directoryFlowField(CHATGPT_PLUGIN_FLOW, issue.key);
      return field?.managedBy !== "package" || present.has(issue.key);
    });
    const pending = unconfirmed.filter(
      (entry) => keys.includes(entry.key) && entry.origin !== undefined
    );
    if (knownIssues.length || pending.length) {
      const lines = knownIssues.map((issue) => {
        const field = directoryFlowField(CHATGPT_PLUGIN_FLOW, issue.key);
        return `${field?.reviewLabel ?? field?.label ?? issue.key}: ${issue.message}`;
      });
      if (pending.length)
        lines.push(
          "Confirm the current attestation wording before submitting."
        );
      return violated(finding, stamp, lines.join(" "), { issues: knownIssues });
    }
    const unknown = keys.filter(
      (key) =>
        directoryFlowField(CHATGPT_PLUGIN_FLOW, key)?.managedBy === "package" &&
        !present.has(key)
    );
    if (unknown.length) {
      return notEvaluated(
        finding,
        stamp,
        "Package values were not imported into this rehearsal, so these fields cannot be graded from the saved answers.",
        { missingInput: "package fields", fields: unknown }
      );
    }
    return satisfied(finding, stamp, { fields: keys });
  });
}

/** These facts are not answers on this form. Name the actual evidence needed. */
const ANSWER_GAPS: Record<string, string> = {
  "openai.submission.test-case-quality":
    "This rehearsal has no execution evidence for the negative test cases. Run them as the reviewer and inspect how each failure is handled.",
  "openai.submission.account":
    "Publisher identity verification and publishing permissions must be checked in OpenAI's dashboard. A developer name does not verify either.",
  "openai.submission.geography":
    "This rehearsal has no country availability evidence. Check the intended countries in the publisher dashboard.",
  "openai.submission.attestation-truth":
    "Confirming attestations records a declaration. A reviewer must establish whether those declarations are true.",
  "openai.submission.scan-currency":
    "This rehearsal has no timestamp for the directory's tool scan. Check the latest scan in the publisher dashboard.",
  "openai.submission.privacy-disclosure":
    "The declared data types have not been compared with the privacy policy. Review both before submitting.",
  "openai.submission.annotation-justifications":
    "This rehearsal has no review justifications for destructive or open-world tools. Check the applicable tools and their justifications in the publisher dashboard.",
  "openai.submission.frame-domain-explanations":
    "This rehearsal has no review explanations for embedded frame domains. Check the applicable domains and their explanations in the publisher dashboard.",
};
