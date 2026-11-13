/** Sample answers to the Claude connector flow, shared by the flow and engine tests. */

import { CLAUDE_CONNECTOR_FLOW } from "../../src/directory-readiness/flows/claude-connector.js";
import { directoryFlowField } from "../../src/directory-readiness/flows/fields.js";
import type {
  DirectoryAnswer,
  DirectoryAnswerValue,
} from "../../src/directory-readiness/flows/types.js";

export const ACKNOWLEDGMENT_VALUES =
  directoryFlowField(
    CLAUDE_CONNECTOR_FLOW,
    "compliance.acknowledgments"
  )?.options?.map((entry) => entry.value) ?? [];

export function answer(
  key: string,
  value: DirectoryAnswerValue
): DirectoryAnswer {
  return { key, value, origin: "set" };
}

/** What the API stores at create: the account's prefills, nothing else. */
export const ACCOUNT_PREFILLS: DirectoryAnswer[] = [
  { key: "company.name", value: "Acme Inc.", origin: "account" },
  { key: "company.contactName", value: "Sample Person", origin: "account" },
  {
    key: "company.contactEmail",
    value: "review@example.com",
    origin: "account",
  },
];

/** A submission the portal would accept, the author left to the company fallback. */
export function completeAnswers(
  changes: DirectoryAnswer[] = []
): DirectoryAnswer[] {
  const changed = new Set(changes.map((entry) => entry.key));
  return [
    ...ACCOUNT_PREFILLS,
    answer("connection.serverUrl", "https://mcp.example.com/mcp"),
    answer("listing.name", "Acme Orders"),
    answer("listing.slug", "acme-orders"),
    answer("listing.oneLiner", "Look up and track Acme orders"),
    answer("listing.description", "Connects Claude to the Acme order system."),
    answer("listing.categories", ["Productivity"]),
    answer("listing.documentationUrl", "https://acme.example/docs"),
    answer("listing.support", "support@acme.example"),
    answer("listing.privacyPolicyUrl", "https://acme.example/privacy"),
    answer("useCases.pairs", [
      { useCase: "Track an order", examplePrompt: "Where is order 1042?" },
    ]),
    answer("useCases.prerequisites", "An Acme account"),
    answer("company.website", "https://acme.example"),
    answer("dataHandling.sponsored", "no"),
    answer("compliance.acknowledgments", ACKNOWLEDGMENT_VALUES),
  ]
    .filter((entry) => !changed.has(entry.key))
    .concat(changes);
}

/** A declaration someone confirmed under the current wording. */
export function confirmed(
  key: string,
  value: DirectoryAnswerValue
): DirectoryAnswer {
  return {
    key,
    value,
    origin: "confirmed",
    wordingRevision: CLAUDE_CONNECTOR_FLOW.version,
  };
}

/**
 * A complete submission that also meets MCPJam's own rules: every
 * declaration confirmed, and test instructions for a server that signs in.
 */
export function confirmedAnswers(
  changes: DirectoryAnswer[] = []
): DirectoryAnswer[] {
  const changed = new Set(changes.map((entry) => entry.key));
  return completeAnswers([
    ...[
      confirmed("useCases.access", "read-only"),
      confirmed("dataHandling.apiOwnership", "own"),
      confirmed("dataHandling.healthData", "no"),
      answer(
        "testLaunch.instructions",
        "Sign in at https://acme.example/review as review@example.com with the password in the review notes."
      ),
      answer("testLaunch.selfTested", true),
    ].filter((entry) => !changed.has(entry.key)),
    ...changes,
  ]);
}
