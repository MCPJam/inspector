/**
 * Submission-artifact checks: Section 5 of Meta's guidelines, plus the two
 * declarations Section 3 asks for.
 *
 * Without a {@link MuseSubmissionProfile} nothing here can be evaluated — not
 * approximated, not inferred from `serverInfo` — so every finding is
 * `not-evaluated` and names `submissionProfile` as the input that closes it.
 *
 * With a profile, presence and shape are DETERMINISTIC (an https URL or not,
 * every tool classified or not, a test account described or not), and each
 * check grades only the fields it needs, so a partial profile still grades
 * what it holds. Truth stays with Meta's reviewers: provenance is `declared`
 * on every finding, so nobody mistakes "the submitter said so" for "we
 * checked".
 *
 * The two classification checks are the exception that reads the wire too:
 * they compare the declared class of each tool against the server's own tool
 * listing, because a declaration that contradicts the server is the one
 * classification error a listing can prove.
 *
 * Pure data. No transport.
 */

import { demonstrableReadWriteVerbs } from "../../directory-readiness/tool-shape.js";
import type { MuseToolEvidence } from "../classification.js";
import { musePolicySource } from "../manifest.js";
import { MUSE_ATTESTATIONS, MUSE_DOCUMENTATION_TOPICS } from "../profile.js";
import type { MuseSubmissionProfile } from "../submission-profile.js";
import type { MuseReadinessFinding } from "../types.js";
import {
  MUSE_READINESS_INPUTS,
  notApplicable,
  notEvaluated,
  satisfied,
  violated,
  type MuseCheckDefinition,
  type MuseCheckStamp,
} from "./helpers.js";
import type { MuseToolListingCompleteness } from "./tools.js";

function declaredCheck(
  id: string,
  title: string,
  section: string,
  checkClass: MuseCheckDefinition["class"] = "required"
): MuseCheckDefinition {
  return {
    id,
    title,
    lane: "submission-artifacts",
    class: checkClass,
    source: musePolicySource("docs", section),
    provenance: "declared",
    intrusiveness: "passive",
  };
}

const OVERVIEW = declaredCheck(
  "muse.submission.overview",
  "The overview names users, tasks, the gain over the browser, and restrictions",
  "§5.1 Connector overview"
);
const CONTACTS = declaredCheck(
  "muse.submission.contacts",
  "Privacy policy, product terms, support and security contacts are supplied",
  "§5.2 Business verification and terms"
);
const ATTESTATIONS = declaredCheck(
  "muse.submission.attestations",
  "Business verification, brand assets, maintainer, data questionnaire and terms are affirmed",
  "§5.2 Business verification and terms"
);
const TOOL_DOCUMENTATION = declaredCheck(
  "muse.submission.tool-documentation",
  "Tool documentation is public and covers every topic §5.4 lists",
  "§5.4 Integration credentials and tool documentation"
);
const INTEGRATION_CREDENTIALS = declaredCheck(
  "muse.submission.integration-credentials",
  "The authentication method, requested scopes and credential environment are declared",
  "§5.4 Integration credentials and tool documentation"
);
const READ_ONLY_OPTION = declaredCheck(
  "muse.submission.read-only-option",
  "OAuth connectors offer a read-only permission option",
  "§3.1 Offer read-only account access",
  // "where possible" — stated guidance, not a disqualifier.
  "recommended"
);
const TEST_ACCOUNT = declaredCheck(
  "muse.submission.test-account",
  "A dedicated test account is described and stays accessible through review",
  "§5.5 Test user credentials and demo"
);
const NO_CHARGE_TEST_PATH = declaredCheck(
  "muse.submission.no-charge-test-path",
  "Transaction tools come with a way to test checkout without real charges",
  "§5.5 Test user credentials and demo"
);
const TOOL_CLASSIFICATIONS = declaredCheck(
  "muse.submission.tool-classifications",
  "Every listed tool has a declared Read, Write or Sensitive-write class",
  "§5.6 Tool annotation"
);
const CLASSIFICATION_CONSISTENT = declaredCheck(
  "muse.submission.classification-consistent",
  "No tool declared Read is a write by the server's own definition",
  "§3.2 How tools are classified"
);

const DEFINITIONS = [
  OVERVIEW,
  CONTACTS,
  ATTESTATIONS,
  TOOL_DOCUMENTATION,
  INTEGRATION_CREDENTIALS,
  READ_ONLY_OPTION,
  TEST_ACCOUNT,
  NO_CHARGE_TEST_PATH,
  TOOL_CLASSIFICATIONS,
  CLASSIFICATION_CONSISTENT,
];

export interface MuseSubmissionEvidence {
  profile?: MuseSubmissionProfile;
  /** Issues from parsing a profile that was supplied but malformed. */
  profileIssues?: string[];
  /** The listing, for the two classification checks only. */
  tools?: readonly MuseToolEvidence[];
  listing?: MuseToolListingCompleteness;
}

// ── Shape helpers ───────────────────────────────────────────────────────

function present(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isHttpsUrl(value: string | undefined): boolean {
  if (!present(value)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isEmail(value: string | undefined): boolean {
  return present(value) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function isContact(value: string | undefined): boolean {
  return isHttpsUrl(value) || isEmail(value);
}

// ── The checks ──────────────────────────────────────────────────────────

export function runMuseSubmissionChecks(
  evidence: MuseSubmissionEvidence,
  stamp: MuseCheckStamp
): MuseReadinessFinding[] {
  const { profile } = evidence;

  if (!profile) {
    // A malformed profile is NOT the same as no profile: saying "no input"
    // would hide the caller's mistake behind a status that reads like ours.
    const reason = evidence.profileIssues?.length
      ? `the supplied submission profile did not validate: ${evidence.profileIssues.join("; ")}`
      : "no submission profile was supplied, and none of these declarations can be read off the wire";
    return DEFINITIONS.map((definition) =>
      notEvaluated(definition, stamp, reason, {
        missingInput: MUSE_READINESS_INPUTS.submissionProfile,
        issues: evidence.profileIssues,
      })
    );
  }

  const findings: MuseReadinessFinding[] = [];

  // §5.1, with §4.3's restriction disclosure.
  const overview = profile.overview ?? {};
  const overviewMissing = [
    present(overview.intendedUsers) ? undefined : "overview.intendedUsers",
    (overview.supportedTasks ?? []).some(present)
      ? undefined
      : "overview.supportedTasks",
    present(overview.browserImprovement)
      ? undefined
      : "overview.browserImprovement",
    present(overview.restrictions) ? undefined : "overview.restrictions",
  ].filter((field): field is string => field !== undefined);
  findings.push(
    overviewMissing.length === 0
      ? satisfied(OVERVIEW, stamp)
      : violated(
          OVERVIEW,
          stamp,
          'Describe the intended users, the supported tasks, how the connector improves on Muse\'s browser, and any account, plan, region, age or usage restrictions (write "none" if there are none).',
          { missing: overviewMissing }
        )
  );

  // §5.2 contacts and terms.
  const contactProblems = [
    isHttpsUrl(profile.privacyPolicyUrl)
      ? undefined
      : "privacyPolicyUrl must be an https:// URL",
    isHttpsUrl(profile.termsUrl)
      ? undefined
      : "termsUrl must be an https:// URL",
    isContact(profile.supportContact)
      ? undefined
      : "supportContact must be an https:// URL or an email address",
    isContact(profile.securityContact)
      ? undefined
      : "securityContact must be an https:// URL or an email address",
  ].filter((problem): problem is string => problem !== undefined);
  findings.push(
    contactProblems.length === 0
      ? satisfied(CONTACTS, stamp)
      : violated(
          CONTACTS,
          stamp,
          "Supply a privacy policy and product terms over HTTPS, plus a support contact and a security contact.",
          { problems: contactProblems }
        )
  );

  // §5.2 / §5.3 / §4.1: claims only Meta can verify. Presence here; truth there.
  const attestations = profile.attestations ?? {};
  const unanswered = MUSE_ATTESTATIONS.filter(
    (name) => attestations[name] === undefined
  );
  const refused = MUSE_ATTESTATIONS.filter(
    (name) => attestations[name] === false
  );
  findings.push(
    unanswered.length === 0 && refused.length === 0
      ? satisfied(ATTESTATIONS, stamp)
      : violated(
          ATTESTATIONS,
          stamp,
          refused.length > 0
            ? `These submission steps are marked not done: ${refused.join(", ")}. Meta requires each of them before review.`
            : `Answer these submission steps: ${unanswered.join(", ")}.`,
          { unanswered, refused }
        )
  );

  // §5.4 documentation.
  const covered = new Set(profile.documentationCovers ?? []);
  const uncovered = MUSE_DOCUMENTATION_TOPICS.filter(
    (topic) => !covered.has(topic)
  );
  const documentationUrlOk = isHttpsUrl(profile.documentationUrl);
  findings.push(
    documentationUrlOk && uncovered.length === 0
      ? satisfied(TOOL_DOCUMENTATION, stamp)
      : violated(
          TOOL_DOCUMENTATION,
          stamp,
          documentationUrlOk
            ? `Your tool documentation must also cover: ${uncovered.join(", ")}.`
            : "Publish API or MCP documentation at an https:// URL covering setup, inputs and outputs, read/write classifications, sensitive designations, permissions, side effects, status handling, errors and rate limits.",
          {
            documentationUrl: documentationUrlOk
              ? profile.documentationUrl
              : undefined,
            uncovered,
          }
        )
  );

  // §5.4 credentials. The credentials themselves never belong in a profile;
  // what is graded is that the shape of the integration is declared.
  const auth = profile.authentication;
  const authProblems: string[] = [];
  if (!auth) {
    authProblems.push("authentication.method is not declared");
  } else {
    if (auth.method === "oauth" && !(auth.scopes ?? []).some(present)) {
      authProblems.push(
        "an OAuth connector must list the scopes Muse will request"
      );
    }
    if (auth.method !== "none" && !auth.credentialsEnvironment) {
      authProblems.push(
        "say whether the credentials are for a test or a production environment"
      );
    }
  }
  findings.push(
    authProblems.length === 0
      ? satisfied(INTEGRATION_CREDENTIALS, stamp, { method: auth?.method })
      : violated(
          INTEGRATION_CREDENTIALS,
          stamp,
          "Declare how Muse authenticates: the method, the scopes it will request, and whether the credentials are for test or production.",
          { problems: authProblems }
        )
  );

  // §3.1 — "where possible", so a stated reason satisfies it.
  if (!auth) {
    findings.push(
      notEvaluated(
        READ_ONLY_OPTION,
        stamp,
        "the profile does not declare an authentication method, so it is unknown whether OAuth applies",
        { missingInput: MUSE_READINESS_INPUTS.submissionProfile }
      )
    );
  } else if (auth.method !== "oauth") {
    findings.push(
      notApplicable(
        READ_ONLY_OPTION,
        stamp,
        "the connector does not use OAuth to connect to a user's account"
      )
    );
  } else {
    const readOnly = (auth.readOnlyScopes ?? []).filter(present);
    const requested = new Set(auth.scopes ?? []);
    const unrequested = readOnly.filter((scope) => !requested.has(scope));
    findings.push(
      readOnly.length > 0 && unrequested.length === 0
        ? satisfied(READ_ONLY_OPTION, stamp, { readOnlyScopes: readOnly })
        : readOnly.length === 0 && present(auth.readOnlyNotPossibleReason)
          ? satisfied(READ_ONLY_OPTION, stamp, {
              readOnlyNotPossibleReason: auth.readOnlyNotPossibleReason,
            })
          : violated(
              READ_ONLY_OPTION,
              stamp,
              readOnly.length === 0
                ? "Offer users a way to limit Muse to Read Only — a read-only scope set — or say why that is not possible for this service."
                : "Every read-only scope must also appear in the requested scopes, or Muse cannot request it.",
              { readOnlyScopes: readOnly, notRequested: unrequested }
            )
    );
  }

  // §5.5 test account.
  const account = profile.testAccount ?? {};
  const accountMissing = [
    present(account.signInInstructions)
      ? undefined
      : "testAccount.signInInstructions",
    present(account.requiredPermissions)
      ? undefined
      : "testAccount.requiredPermissions",
    present(account.representativeTestData)
      ? undefined
      : "testAccount.representativeTestData",
    account.accessibleThroughoutReview === true
      ? undefined
      : "testAccount.accessibleThroughoutReview",
  ].filter((field): field is string => field !== undefined);
  findings.push(
    accountMissing.length === 0
      ? satisfied(TEST_ACCOUNT, stamp)
      : violated(
          TEST_ACCOUNT,
          stamp,
          "Provide a dedicated test account: sign-in instructions, the permissions it needs, representative test data, and a commitment to keep it accessible throughout review.",
          { missing: accountMissing }
        )
  );

  // §5.5 transaction testing — conditional on there being transaction tools,
  // which only the submitter can say.
  if (!profile.transactions) {
    findings.push(
      notEvaluated(
        NO_CHARGE_TEST_PATH,
        stamp,
        "the profile does not say whether the connector has transaction tools",
        { missingInput: MUSE_READINESS_INPUTS.submissionProfile }
      )
    );
  } else if (!profile.transactions.hasTransactionTools) {
    findings.push(
      notApplicable(
        NO_CHARGE_TEST_PATH,
        stamp,
        "the submitter declares no transaction tools"
      )
    );
  } else {
    findings.push(
      present(profile.transactions.noChargeTestPath)
        ? satisfied(NO_CHARGE_TEST_PATH, stamp)
        : violated(
            NO_CHARGE_TEST_PATH,
            stamp,
            "Explain how reviewers can test checkout without real charges — a test mode, test cards, or a sandbox merchant."
          )
    );
  }

  findings.push(...classificationChecks(evidence, profile, stamp));
  return findings;
}

/** §5.6 and §3.2: the declared classes, against the server's own listing. */
function classificationChecks(
  evidence: MuseSubmissionEvidence,
  profile: MuseSubmissionProfile,
  stamp: MuseCheckStamp
): MuseReadinessFinding[] {
  const { tools, listing } = evidence;
  if (!tools || listing?.complete === false) {
    const reason = !tools
      ? "no tool listing was captured, so there is nothing to compare the declared classes against"
      : `${listing?.error ?? "the tool listing was truncated"}, so "every tool" cannot be graded`;
    return [TOOL_CLASSIFICATIONS, CLASSIFICATION_CONSISTENT].map((definition) =>
      notEvaluated(definition, stamp, reason, {
        missingInput: MUSE_READINESS_INPUTS.toolListing,
      })
    );
  }
  if (tools.length === 0) {
    return [TOOL_CLASSIFICATIONS, CLASSIFICATION_CONSISTENT].map((definition) =>
      notApplicable(
        definition,
        stamp,
        "the server advertises no tools, so there is nothing to classify"
      )
    );
  }

  const declared = profile.toolClassifications ?? {};
  const has = (name: string) =>
    Object.prototype.hasOwnProperty.call(declared, name);
  const listed = new Set(tools.map((tool) => tool.name));
  const unclassified = tools
    .filter((tool) => !has(tool.name))
    .map((tool) => tool.name);
  // Not a violation: a tool gated behind a scope this run did not hold is
  // legitimately absent from the listing. Reported so a stale entry is visible.
  const notListed = Object.keys(declared)
    .filter((name) => !listed.has(name))
    .sort();

  const findings: MuseReadinessFinding[] = [
    unclassified.length === 0
      ? satisfied(TOOL_CLASSIFICATIONS, stamp, {
          toolCount: tools.length,
          ...(notListed.length > 0 ? { declaredButNotListed: notListed } : {}),
        })
      : violated(
          TOOL_CLASSIFICATIONS,
          stamp,
          "Classify every tool as Read, Write or Sensitive write in your tool documentation (the portal will take this directly once §5.6 ships). The classification sheet in this report is a starting point.",
          {
            unclassified,
            ...(notListed.length > 0
              ? { declaredButNotListed: notListed }
              : {}),
          }
        ),
  ];

  const declaredRead = tools.filter((tool) => declared[tool.name] === "read");
  if (declaredRead.length === 0) {
    findings.push(
      Object.keys(declared).length === 0
        ? notEvaluated(
            CLASSIFICATION_CONSISTENT,
            stamp,
            "no tool classifications were declared, so there is nothing to compare",
            { missingInput: MUSE_READINESS_INPUTS.submissionProfile }
          )
        : satisfied(CLASSIFICATION_CONSISTENT, stamp, { declaredRead: 0 })
    );
    return findings;
  }

  // A contradiction is the SERVER's own word against the declaration:
  // `readOnlyHint: false`, `destructiveHint: true`, or an enumerated write
  // operation. An absent hint contradicts nothing — MCP's default is "no
  // claim" — and is left to the classification sheet to question.
  const contradictions = declaredRead.flatMap((tool) => {
    const reasons: string[] = [];
    if (tool.annotations?.readOnlyHint === false) {
      reasons.push("declares readOnlyHint: false");
    }
    if (tool.annotations?.destructiveHint === true) {
      reasons.push("declares destructiveHint: true");
    }
    const combined = demonstrableReadWriteVerbs(tool);
    if (combined) {
      reasons.push(
        `"${combined.parameter}" enumerates write operations (${combined.unsafe.join(", ")})`
      );
    }
    return reasons.length > 0 ? [{ tool: tool.name, reasons }] : [];
  });
  findings.push(
    contradictions.length === 0
      ? satisfied(CLASSIFICATION_CONSISTENT, stamp, {
          declaredRead: declaredRead.length,
        })
      : violated(
          CLASSIFICATION_CONSISTENT,
          stamp,
          "These tools are declared Read, but the server's own definition says they write. A tool that combines reads and writes is a write — reclassify it, or fix its annotations if they are wrong.",
          { tools: contradictions }
        )
  );
  return findings;
}
