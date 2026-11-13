/**
 * The connector form's remaining steps graded from a submission's answers.
 * Each check owns one step's answers, so a problem is reported once, in the
 * portal's words when the portal refuses it. A rule the portal does not
 * state is MCPJam's and says so: both halves of a use-case row, an https
 * company website, a declaration confirmed rather than left at a default.
 * Test instructions come from Claude's review criteria, and say that too.
 *
 * Pure. No transport.
 */

import { CLAUDE_CONNECTOR_FLOW } from "../../directory-readiness/flows/claude-connector.js";
import { directoryFlowField } from "../../directory-readiness/flows/fields.js";
import type {
  DirectoryAnswerValue,
  DirectoryFieldIssue,
  DirectoryFlowOption,
} from "../../directory-readiness/flows/types.js";
import type { ClaudeAnswerEvidence } from "../answers.js";
import { claudePolicySource } from "../manifest.js";
import type { ClaudeReadinessFinding } from "../types.js";
import type { ClaudeAuthEvidence } from "./auth.js";
import { describeUnconfirmed, NO_ANSWERS } from "./declarations.js";
import {
  notApplicable,
  notEvaluated,
  satisfied,
  violated,
  type ClaudeCheckDefinition,
  type ClaudeCheckStamp,
} from "./helpers.js";

/** What every check here is: a requirement on answers someone declared. */
const DECLARED = {
  lane: "submission-artifacts",
  class: "required",
  provenance: "declared",
  intrusiveness: "passive",
} as const;

const USE_CASES: ClaudeCheckDefinition = {
  id: "claude.submission.use-cases",
  title: "Use cases have example prompts, and prerequisites are given",
  source: claudePolicySource("submission", "§Use cases"),
  ...DECLARED,
};

const COMPANY: ClaudeCheckDefinition = {
  id: "claude.submission.company",
  title: "The company's name, https website and primary contact are given",
  source: claudePolicySource("submission", "§Company"),
  ...DECLARED,
};

const AUTHENTICATION: ClaudeCheckDefinition = {
  id: "claude.submission.authentication",
  title: "The authentication requirement and OAuth client are answered",
  source: claudePolicySource("submission", "§Authentication"),
  ...DECLARED,
};

const DATA_HANDLING: ClaudeCheckDefinition = {
  id: "claude.submission.data-handling",
  title: "Data handling is answered and confirmed",
  source: claudePolicySource("submission", "§Data handling"),
  ...DECLARED,
};

const TEST_INSTRUCTIONS: ClaudeCheckDefinition = {
  id: "claude.submission.test-instructions",
  title:
    "Reviewers get test-account instructions when the server needs sign-in",
  source: claudePolicySource("review-criteria", "§Test credentials"),
  ...DECLARED,
};

const DEFINITIONS = [
  USE_CASES,
  COMPANY,
  AUTHENTICATION,
  DATA_HANDLING,
  TEST_INSTRUCTIONS,
];

const PAIRS = "useCases.pairs";
const REQUIREMENT = "authentication.requirement";
const CLIENT = "authentication.oauthClient";
const INSTRUCTIONS = "testLaunch.instructions";
const COMPANY_KEYS = [
  "company.name",
  "company.website",
  "company.contactName",
  "company.contactEmail",
];
const DATA_KEYS = [
  "dataHandling.apiOwnership",
  "dataHandling.healthData",
  "dataHandling.sponsored",
];

const MCPJAM_CHECK = "This is an MCPJam check.";
const AS_THEY_STAND =
  "This is an MCPJam check; the portal submits answers as they stand.";

/** Answers that break MCPJam's own rules, and the note that says so. */
export interface ClaudeOwnRuleProblems {
  lines: readonly string[];
  note: string;
}

export function runClaudeAnswerStepChecks(
  answers: ClaudeAnswerEvidence | undefined,
  stamp: ClaudeCheckStamp
): ClaudeReadinessFinding[] {
  if (!answers) {
    return DEFINITIONS.map((definition) =>
      notEvaluated(definition, stamp, NO_ANSWERS)
    );
  }
  return [
    useCasesFinding(answers, stamp),
    gradeOwnedAnswers(
      COMPANY,
      answers,
      COMPANY_KEYS,
      stamp,
      {},
      httpsWebsite(answers)
    ),
    gradeOwnedAnswers(AUTHENTICATION, answers, [REQUIREMENT, CLIENT], stamp, {
      requirement: answers.values[REQUIREMENT],
      oauthClient: answers.values[CLIENT],
    }),
    gradeOwnedAnswers(
      DATA_HANDLING,
      answers,
      DATA_KEYS,
      stamp,
      {
        declared: Object.fromEntries(
          DATA_KEYS.map((key) => [key, answers.values[key]])
        ),
      },
      unconfirmedProblems(answers, DATA_KEYS)
    ),
    testInstructionsFinding(answers, stamp),
  ];
}

/**
 * Grade the answers one check owns. The portal's issues come first, in its
 * words; a changed wording and `own` problems are MCPJam's and say so.
 */
export function gradeOwnedAnswers(
  definition: ClaudeCheckDefinition,
  answers: ClaudeAnswerEvidence,
  keys: readonly string[],
  stamp: ClaudeCheckStamp,
  details: Record<string, unknown> = {},
  own: ClaudeOwnRuleProblems = { lines: [], note: MCPJAM_CHECK }
): ClaudeReadinessFinding {
  const issues = answers.issues.filter((issue) => keys.includes(issue.key));
  const portal = issues.filter((issue) => issue.code !== "wordingChanged");
  const ours = [
    ...issues.filter((issue) => issue.code === "wordingChanged").map(line),
    ...own.lines,
  ];
  if (portal.length === 0 && ours.length === 0) {
    return satisfied(definition, stamp, details);
  }
  const lead = portal.length === 1 ? "this answer" : "these answers";
  const sentences = [
    ...(portal.length > 0
      ? [`Fix ${lead} before you submit.`, ...portal.map(line)]
      : []),
    ...(ours.length > 0 ? [...ours, own.note] : []),
  ];
  return violated(definition, stamp, sentences.join(" "), {
    ...details,
    issues,
  });
}

/**
 * The Authentication answers held against what the run saw of the server's
 * sign-in. The portal applies them to connections exactly as entered, so a
 * mismatch is a connection that fails. When the run did not see what a
 * comparison needs, it is not made, and the reason names what was not seen.
 */
export function compareAuthAnswersWithServer(
  definition: ClaudeCheckDefinition,
  answers: ClaudeAnswerEvidence,
  auth: ClaudeAuthEvidence | undefined,
  stamp: ClaudeCheckStamp
): ClaudeReadinessFinding {
  const requirement = option(REQUIREMENT, answers.values[REQUIREMENT]);
  const client = option(CLIENT, answers.values[CLIENT]);
  const blank = !requirement
    ? REQUIREMENT
    : requirement.value !== "none" && !client
      ? CLIENT
      : undefined;
  if (!requirement || blank) {
    return notEvaluated(
      definition,
      stamp,
      `${labelOf(blank ?? REQUIREMENT)} has no answer the portal offers, so there is nothing to compare with the server's sign-in`,
      { missingInput: blank }
    );
  }

  const probe = auth?.unauthenticated;
  const server = auth?.firstAuthorizationServer;
  const metadata = server?.reachable ? server.document : undefined;
  const said = (key: string, chosen: DirectoryFlowOption) =>
    `${labelOf(key)} says ${chosen.label}`;
  const choice = (value: string) => option(REQUIREMENT, value)?.label ?? value;
  const conflicts: string[] = [];
  const unseen: string[] = [];

  if (!probe) {
    unseen.push("the server's answer to a request without sign-in");
  } else if (requirement.value === "none" && probe.status === 401) {
    conflicts.push(
      `${said(REQUIREMENT, requirement)}, but the server refused a request made without sign-in. Choose ${choice("always")} or ${choice("when-asked")}.`
    );
  } else if (
    requirement.value === "always" &&
    probe.servedWithoutCredentials &&
    auth?.prm?.discoveredVia === "not-found" &&
    !auth.prm.unanswered
  ) {
    conflicts.push(
      `${said(REQUIREMENT, requirement)}, but the server answered without sign-in and publishes no OAuth metadata, so Claude cannot sign users in. Choose ${choice("none")} or ${choice("when-asked")}, or publish Protected Resource Metadata.`
    );
  }

  // A preregistered client works with any authorization server.
  const needs = client && ADVERTISED.get(client.value);
  if (requirement.value !== "none" && client && needs) {
    if (!metadata) unseen.push("the authorization server's metadata");
    else if (!needs.offers(metadata)) {
      conflicts.push(`${said(CLIENT, client)}, ${needs.otherwise}`);
    }
  }

  const details = {
    declared: { requirement: requirement.value, oauthClient: client?.value },
    observed: {
      status: probe?.status,
      servedWithoutCredentials: probe?.servedWithoutCredentials,
      metadataDiscovery: auth?.prm?.discoveredVia,
      registrationEndpoint:
        metadata && typeof metadata.registration_endpoint === "string",
      clientIdMetadataDocumentSupported:
        metadata?.client_id_metadata_document_supported,
    },
  };
  if (conflicts.length > 0) {
    return violated(definition, stamp, conflicts.join(" "), details);
  }
  if (unseen.length > 0) {
    return notEvaluated(
      definition,
      stamp,
      `this run did not see ${unseen.join(" or ")}, so the Authentication answers were not compared with the server`,
      details
    );
  }
  return satisfied(definition, stamp, details);
}

/** OAuth client types that need the authorization server to offer them. */
const ADVERTISED = new Map<
  string,
  { offers: (metadata: Record<string, unknown>) => boolean; otherwise: string }
>([
  [
    "dcr",
    {
      offers: (metadata) => typeof metadata.registration_endpoint === "string",
      otherwise:
        "but the authorization server's metadata has no registration_endpoint. Choose the client type the server supports, or turn on dynamic registration.",
    },
  ],
  [
    "cimd",
    {
      offers: (metadata) =>
        metadata.client_id_metadata_document_supported === true,
      otherwise:
        "but the authorization server does not set client_id_metadata_document_supported to true. Choose the client type the server supports, or turn that support on.",
    },
  ],
]);

/**
 * Declarations among `keys` holding a value nobody stood behind. One with no
 * answer, or with an issue of its own, is already the portal's to report.
 */
export function unconfirmedProblems(
  answers: ClaudeAnswerEvidence,
  keys: readonly string[]
): ClaudeOwnRuleProblems {
  const flagged = new Set(answers.issues.map((issue) => issue.key));
  const pending = answers.unconfirmed
    .filter((entry) => keys.includes(entry.key) && !flagged.has(entry.key))
    .filter((entry) => entry.origin !== undefined);
  const them = pending.length === 1 ? "this answer" : "these answers";
  const listed = pending.map(describeUnconfirmed).join(", ");
  const lines =
    pending.length > 0 ? [`Confirm or change ${them}: ${listed}.`] : [];
  return { lines, note: AS_THEY_STAND };
}

function useCasesFinding(
  answers: ClaudeAnswerEvidence,
  stamp: ClaudeCheckStamp
): ClaudeReadinessFinding {
  const pairs = directoryFlowField(CLAUDE_CONNECTOR_FLOW, PAIRS)?.pairs;
  const [first, second] = pairs?.keys ?? ["useCase", "examplePrompt"];
  const [named, prompt] = pairs?.columns ?? ["Use case", "Example prompt"];
  const rows = rowsOf(answers.values[PAIRS]);
  const has = (row: Record<string, string>, key: string) =>
    (row[key] ?? "").trim() !== "";
  // A row with one half filled in. The portal's own line covers a form with
  // no complete row, so these are named only beside a complete one.
  const halves = rows.flatMap((row, index) =>
    has(row, first) === has(row, second)
      ? []
      : [
          has(row, first)
            ? `${named} ${index + 1} has no ${prompt.toLowerCase()}.`
            : `${prompt} ${index + 1} has no ${named.toLowerCase()}.`,
        ]
  );
  const portalFlagged = answers.issues.some((issue) => issue.key === PAIRS);
  const own =
    halves.length > 0 && !portalFlagged
      ? {
          lines: [
            ...halves,
            `Fill in the other half or clear ${halves.length === 1 ? "the row" : "those rows"}.`,
          ],
          note: "This is an MCPJam check; the portal asks for one complete row.",
        }
      : undefined;
  return gradeOwnedAnswers(
    USE_CASES,
    answers,
    [PAIRS, "useCases.prerequisites"],
    stamp,
    {
      useCases: rows.filter((row) => has(row, first) && has(row, second))
        .length,
      maxRows: pairs?.maxRows,
    },
    own
  );
}

/** An http website passes the form but cannot stand in as the author. */
function httpsWebsite(
  answers: ClaudeAnswerEvidence
): ClaudeOwnRuleProblems | undefined {
  const key = "company.website";
  const website = String(answers.values[key] ?? "").trim();
  const flagged = answers.issues.some((issue) => issue.key === key);
  if (flagged || !website || /^https:/i.test(website)) return undefined;
  return {
    lines: [`${labelOf(key)} is not https. Use an https:// address.`],
    note: "This is an MCPJam check; the review page uses the company website as the author only when it is https.",
  };
}

function testInstructionsFinding(
  answers: ClaudeAnswerEvidence,
  stamp: ClaudeCheckStamp
): ClaudeReadinessFinding {
  const requirement = option(REQUIREMENT, answers.values[REQUIREMENT]);
  if (!requirement) {
    return notEvaluated(
      TEST_INSTRUCTIONS,
      stamp,
      `${labelOf(REQUIREMENT)} has no answer the portal offers, so it is not known whether reviewers need a test account`,
      { missingInput: REQUIREMENT }
    );
  }
  if (requirement.value === "none") {
    return notApplicable(
      TEST_INSTRUCTIONS,
      stamp,
      `${labelOf(REQUIREMENT)} says ${requirement.label}, so reviewers need no test account`
    );
  }
  const instructions = answers.values[INSTRUCTIONS];
  if (typeof instructions === "string" && instructions.trim() !== "") {
    return satisfied(TEST_INSTRUCTIONS, stamp, {
      requirement: requirement.value,
      instructionsLength: instructions.trim().length,
    });
  }
  return violated(
    TEST_INSTRUCTIONS,
    stamp,
    `${labelOf(INSTRUCTIONS)}: add a test account and the steps a reviewer needs to sign in and run every tool. Claude's review criteria require test credentials for a server that needs sign-in, and ${labelOf(REQUIREMENT)} says ${requirement.label}. The portal accepts this field empty.`,
    { requirement: requirement.value }
  );
}

/** "One-liner: Use 200 characters or fewer." with the review page's label. */
function line({ key, message }: DirectoryFieldIssue): string {
  return `${labelOf(key)}: ${message}${/[.!?]$/.test(message) ? "" : "."}`;
}

function labelOf(key: string): string {
  const field = directoryFlowField(CLAUDE_CONNECTOR_FLOW, key);
  return field?.reviewLabel ?? field?.label ?? key;
}

/** The option a field offers for `value`, if it offers one. */
function option(key: string, value: unknown): DirectoryFlowOption | undefined {
  return directoryFlowField(CLAUDE_CONNECTOR_FLOW, key)?.options?.find(
    (entry) => entry.value === value
  );
}

function rowsOf(value: DirectoryAnswerValue | undefined) {
  return Array.isArray(value)
    ? (value as ReadonlyArray<string | Record<string, string>>).filter(
        (row): row is Record<string, string> =>
          typeof row === "object" && row !== null
      )
    : [];
}
