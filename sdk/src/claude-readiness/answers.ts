/**
 * A Claude connector submission's answers, read as the portal reads them when
 * someone presses Submit: the review page's rules, the portal's preselected
 * defaults filled in, and the Authentication step translated into the
 * declared auth mode the auth checks already understand.
 *
 * Pure. No transport.
 */

import { CLAUDE_CONNECTOR_FLOW } from "../directory-readiness/flows/claude-connector.js";
import {
  unconfirmedDeclarations,
  withDirectoryFlowDefaults,
} from "../directory-readiness/flows/fields.js";
import type {
  DirectoryAnswer,
  DirectoryAnswerOrigin,
  DirectoryAnswerValue,
  DirectoryFieldIssue,
  DirectoryUnconfirmedDeclaration,
} from "../directory-readiness/flows/types.js";
import { validateDirectoryAnswers } from "../directory-readiness/flows/validate.js";
import type { ClaudeDeclaredAuthMode } from "./submission-profile.js";

export interface ClaudeAnswerEvidence {
  /** What the review page would refuse, at most one issue per field. */
  issues: DirectoryFieldIssue[];
  /** Every answer by key, the portal's defaults included. */
  values: Readonly<Record<string, DirectoryAnswerValue>>;
  /** Where each answer came from; `default` for the portal's preselection. */
  origins: Readonly<Record<string, DirectoryAnswerOrigin>>;
  /** Declarations nobody has stood behind yet. */
  unconfirmed: DirectoryUnconfirmedDeclaration[];
  /** The Authentication step's choice; absent while it is unanswered. */
  declaredAuthMode?: ClaudeDeclaredAuthMode;
}

/**
 * Both clients the installer does not register at connect time are
 * preregistered out of band, which is what reclassifies the acquisition path.
 */
const AUTH_MODE_BY_CLIENT = new Map<unknown, ClaudeDeclaredAuthMode>([
  ["dcr", "oauth-dcr"],
  ["cimd", "oauth-cimd"],
  ["anthropic-held", "oauth-preregistered"],
  ["bring-your-own", "oauth-preregistered"],
]);

export function claudeSubmissionEvidenceFromAnswers(
  answers: readonly DirectoryAnswer[]
): ClaudeAnswerEvidence {
  const merged = withDirectoryFlowDefaults(CLAUDE_CONNECTOR_FLOW, answers);
  const values = Object.fromEntries(
    merged.map((answer) => [answer.key, answer.value])
  );
  const requirement = values["authentication.requirement"];
  const client = values["authentication.oauthClient"];
  return {
    issues: validateDirectoryAnswers(CLAUDE_CONNECTOR_FLOW, answers, {
      on: "review",
    }),
    values,
    origins: Object.fromEntries(
      merged.map((answer) => [answer.key, answer.origin])
    ),
    unconfirmed: unconfirmedDeclarations(CLAUDE_CONNECTOR_FLOW, answers),
    declaredAuthMode:
      requirement === "none"
        ? "authless"
        : requirement === "always" || requirement === "when-asked"
          ? AUTH_MODE_BY_CLIENT.get(client)
          : undefined,
  };
}
