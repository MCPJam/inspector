/**
 * Submission-artifact checks.
 *
 * The lane's whole shape follows from one fact: without a
 * {@link ClaudeSubmissionProfile}, none of this can be evaluated. Not
 * approximated, not inferred from `serverInfo.name` — a listing name is a
 * field on a form, and a server's advertised name is a different thing that
 * frequently differs. So with no profile every finding here is
 * `not-evaluated`, the lane is `incomplete`, and the coverage names
 * `submissionProfile` as the input that would close it.
 *
 * A connector submission's ANSWERS replace the profile when present: the
 * listing, link and acknowledgment checks report exactly what the portal's
 * review page would refuse, in its words, and the screenshot checks are
 * not-applicable because the connector form has no screenshots. The
 * acknowledgments must also be confirmed, and the Authentication answers are
 * held against the server's sign-in; `answer-steps.ts` grades the other steps.
 *
 * With a profile, the split is sharp:
 *
 *   - DETERMINISTIC — presence, lengths, URL shapes, image type and pixel
 *     dimensions, attestation completeness. These are `required` and they pass
 *     or fail on the bytes.
 *   - MANUAL — whether a screenshot shows the product, whether the submitter
 *     owns the domain, whether an attestation is TRUE. These are
 *     `manual-review` with `declared` provenance, so no reader can mistake
 *     "the submitter said so" for "we checked".
 *
 * Pure data. No transport.
 */

import { CLAUDE_CONNECTOR_FLOW } from "../../directory-readiness/flows/claude-connector.js";
import { directoryFlowField } from "../../directory-readiness/flows/fields.js";
import type { ClaudeAnswerEvidence } from "../answers.js";
import { claudePolicySource } from "../manifest.js";
import { CLAUDE_SUBMISSION_LIMITS } from "../profile.js";
import {
  CLAUDE_ATTESTATIONS,
  type ClaudeSubmissionProfile,
} from "../submission-profile.js";
import type { ClaudeReadinessFinding } from "../types.js";
import {
  compareAuthAnswersWithServer,
  gradeOwnedAnswers,
  unconfirmedProblems,
} from "./answer-steps.js";
import type { ClaudeAuthEvidence } from "./auth.js";
import {
  informational,
  notApplicable,
  notEvaluated,
  satisfied,
  violated,
  type ClaudeCheckDefinition,
  type ClaudeCheckStamp,
} from "./helpers.js";

const LISTING_FIELDS: ClaudeCheckDefinition = {
  id: "claude.submission.listing-fields",
  title: "Listing name, slug, one-liner, description, categories and author are valid",
  lane: "submission-artifacts",
  class: "required",
  source: claudePolicySource("submission", "§Listing details"),
  provenance: "declared",
  intrusiveness: "passive",
};

const LISTING_URLS: ClaudeCheckDefinition = {
  id: "claude.submission.urls",
  title: "Documentation, privacy policy and support links are valid",
  lane: "submission-artifacts",
  class: "required",
  source: claudePolicySource("submission", "§Listing details → Links"),
  provenance: "declared",
  intrusiveness: "passive",
};

const SCREENSHOTS: ClaudeCheckDefinition = {
  id: "claude.submission.screenshots",
  title: "Screenshots meet count, format and resolution requirements",
  lane: "submission-artifacts",
  class: "required",
  source: claudePolicySource("submission", "§Screenshots"),
  provenance: "declared",
  intrusiveness: "passive",
};

const SCREENSHOT_PROMPTS: ClaudeCheckDefinition = {
  id: "claude.submission.screenshot-prompts",
  title: "Every screenshot is paired with the prompt it illustrates",
  lane: "submission-artifacts",
  class: "required",
  source: claudePolicySource("submission", "§Screenshots"),
  provenance: "declared",
  intrusiveness: "passive",
};

const ATTESTATIONS: ClaudeCheckDefinition = {
  id: "claude.submission.attestations",
  title: "All seven submission attestations are affirmed",
  lane: "submission-artifacts",
  class: "required",
  source: claudePolicySource("submission", "§Attestations"),
  provenance: "declared",
  intrusiveness: "passive",
};

const ARTIFACT_QUALITY: ClaudeCheckDefinition = {
  id: "claude.submission.artifact-quality",
  title: "Listing copy, screenshots and ownership need a human reviewer",
  lane: "submission-artifacts",
  class: "manual-review",
  source: claudePolicySource("review-criteria", "§Listing quality"),
  provenance: "declared",
  intrusiveness: "passive",
};

const DECLARED_AUTH_MATCHES: ClaudeCheckDefinition = {
  id: "claude.submission.declared-auth-mode",
  title: "The declared authentication mode matches what the server does",
  lane: "submission-artifacts",
  class: "required",
  source: claudePolicySource("submission", "§Authentication"),
  provenance: "declared",
  intrusiveness: "passive",
};

const DEFINITIONS = [
  LISTING_FIELDS,
  LISTING_URLS,
  SCREENSHOTS,
  SCREENSHOT_PROMPTS,
  ATTESTATIONS,
  DECLARED_AUTH_MATCHES,
  ARTIFACT_QUALITY,
];

/** The named input a caller supplies to make this lane evaluable. */
export const CLAUDE_SUBMISSION_PROFILE_INPUT = "submissionProfile";

/** PNG only: the listing gallery renders these, and a JPEG is rejected. */
const ACCEPTED_SCREENSHOT_MIME = ["image/png"];

export interface ClaudeSubmissionEvidence {
  /** A connector submission's answers. Graded instead of a profile when present. */
  answers?: ClaudeAnswerEvidence;
  profile?: ClaudeSubmissionProfile;
  /** Issues from parsing a profile that was supplied but malformed. */
  profileIssues?: string[];
  /**
   * How the run OBSERVED the server authenticating, when it could tell. Used
   * only to contradict a declaration — never to supply one, because several
   * legitimate modes (static header, custom connection, preregistered client)
   * are indistinguishable from outside.
   */
  observedAuthMode?: string;
  /** What the run saw of the server's sign-in, held against the answers. */
  auth?: ClaudeAuthEvidence;
}

export function runClaudeSubmissionChecks(
  evidence: ClaudeSubmissionEvidence,
  stamp: ClaudeCheckStamp,
): ClaudeReadinessFinding[] {
  const { profile } = evidence;
  if (evidence.answers) return gradeAnswers(evidence, evidence.answers, stamp);

  if (!profile) {
    // A malformed profile is NOT the same as no profile: the caller did the
    // work and got it wrong, and saying "no input" would hide their mistake
    // behind a status that reads like our limitation.
    const reason = evidence.profileIssues?.length
      ? `the supplied submission profile did not validate: ${evidence.profileIssues.join("; ")}`
      : `no submission profile was supplied, and none of these fields can be inferred from the wire (\`serverInfo.name\` is not the listing name)`;
    return DEFINITIONS.map((definition) =>
      notEvaluated(definition, stamp, reason, {
        missingInput: CLAUDE_SUBMISSION_PROFILE_INPUT,
        issues: evidence.profileIssues,
      }),
    );
  }

  const findings: ClaudeReadinessFinding[] = [];

  // RE-CHECKED, not assumed. A profile that came through
  // `parseClaudeSubmissionProfile` cannot violate these bounds, but
  // `ClaudeSubmissionEvidence.profile` is a typed field a caller can populate
  // directly, and a check that reported `satisfied` without looking would be
  // asserting something it never verified.
  const overLongFields = [
    ["name", profile.name.length, CLAUDE_SUBMISSION_LIMITS.nameMaxLength],
    [
      "tagline",
      profile.tagline.length,
      CLAUDE_SUBMISSION_LIMITS.oneLinerMaxLength,
    ],
    [
      "description",
      profile.description.length,
      CLAUDE_SUBMISSION_LIMITS.descriptionMaxLength,
    ],
  ].filter(([, length, limit]) => (length as number) > (limit as number));
  const categoryCount = profile.categories.length;
  const categoriesOutOfRange =
    categoryCount < CLAUDE_SUBMISSION_LIMITS.categoriesMin ||
    categoryCount > CLAUDE_SUBMISSION_LIMITS.categoriesMax;

  findings.push(
    overLongFields.length > 0 || categoriesOutOfRange
      ? violated(
          LISTING_FIELDS,
          stamp,
          `Listing fields must fit their limits: name ≤ ${CLAUDE_SUBMISSION_LIMITS.nameMaxLength}, tagline ≤ ${CLAUDE_SUBMISSION_LIMITS.oneLinerMaxLength}, description ≤ ${CLAUDE_SUBMISSION_LIMITS.descriptionMaxLength}, and ${CLAUDE_SUBMISSION_LIMITS.categoriesMin}–${CLAUDE_SUBMISSION_LIMITS.categoriesMax} categories.`,
          {
            overLong: overLongFields.map(([field, length, limit]) => ({
              field,
              length,
              limit,
            })),
            categories: categoryCount,
          },
        )
      : satisfied(LISTING_FIELDS, stamp, {
      nameLength: profile.name.length,
      taglineLength: profile.tagline.length,
      descriptionLength: profile.description.length,
      categories: profile.categories.length,
          limits: {
            name: CLAUDE_SUBMISSION_LIMITS.nameMaxLength,
            tagline: CLAUDE_SUBMISSION_LIMITS.oneLinerMaxLength,
            description: CLAUDE_SUBMISSION_LIMITS.descriptionMaxLength,
          },
        }),
  );

  const listingUrls = {
    documentationUrl: profile.documentationUrl,
    privacyPolicyUrl: profile.privacyPolicyUrl,
    supportUrl: profile.supportUrl,
    iconUrl: profile.iconUrl,
  };
  const insecureUrls = Object.entries(listingUrls).filter(
    ([, url]) => !isHttpsUrl(url),
  );
  findings.push(
    insecureUrls.length === 0
      ? satisfied(LISTING_URLS, stamp, listingUrls)
      : violated(
          LISTING_URLS,
          stamp,
          "Every listing link must be an https:// URL.",
          { insecure: insecureUrls.map(([field, url]) => ({ field, url })) },
        ),
  );

  const screenshotCount = profile.screenshots.length;
  const countOutOfRange =
    screenshotCount < CLAUDE_SUBMISSION_LIMITS.screenshotsMin ||
    screenshotCount > CLAUDE_SUBMISSION_LIMITS.screenshotsMax;
  const badFormat = profile.screenshots.filter(
    (shot) =>
      !ACCEPTED_SCREENSHOT_MIME.includes(shot.mimeType.split(";")[0].trim().toLowerCase()),
  );
  const tooNarrow = profile.screenshots.filter(
    (shot) => shot.widthPx < CLAUDE_SUBMISSION_LIMITS.screenshotMinWidthPx,
  );
  // The COUNT is evaluated here too, because the remediation names it. A
  // message that quotes a range the check never looked at tells a submitter
  // with too few screenshots that their screenshots are fine.
  findings.push(
    badFormat.length === 0 && tooNarrow.length === 0 && !countOutOfRange
      ? satisfied(SCREENSHOTS, stamp, { count: screenshotCount })
      : violated(
          SCREENSHOTS,
          stamp,
          `Supply ${CLAUDE_SUBMISSION_LIMITS.screenshotsMin}–${CLAUDE_SUBMISSION_LIMITS.screenshotsMax} PNG screenshots at least ${CLAUDE_SUBMISSION_LIMITS.screenshotMinWidthPx}px wide.`,
          {
            wrongFormat: badFormat.map((shot) => ({
              url: shot.url,
              mimeType: shot.mimeType,
            })),
            tooNarrow: tooNarrow.map((shot) => ({
              url: shot.url,
              widthPx: shot.widthPx,
            })),
            count: screenshotCount,
          },
        ),
  );

  const unpaired = profile.screenshots.filter((shot) => !shot.prompt.trim());
  findings.push(
    unpaired.length === 0
      ? satisfied(SCREENSHOT_PROMPTS, stamp)
      : violated(
          SCREENSHOT_PROMPTS,
          stamp,
          "Pair every screenshot with the prompt it illustrates — a gallery with no prompts does not show a reviewer what the connector does.",
          { unpaired: unpaired.map((shot) => shot.url) },
        ),
  );

  // A missing key and an explicit `false` are different failures: an
  // incomplete form versus a refusal to affirm. Naming both tells the
  // submitter which one they are looking at.
  const missing = CLAUDE_ATTESTATIONS.filter(
    (attestation) => profile.attestations[attestation] === undefined,
  );
  const denied = CLAUDE_ATTESTATIONS.filter(
    (attestation) => profile.attestations[attestation] === false,
  );
  findings.push(
    missing.length === 0 && denied.length === 0
      ? satisfied(ATTESTATIONS, stamp, { affirmed: CLAUDE_ATTESTATIONS.length })
      : violated(
          ATTESTATIONS,
          stamp,
          missing.length > 0 && denied.length > 0
            ? "Some attestations are unanswered and some are declined; all seven must be affirmed."
            : missing.length > 0
              ? "Some attestations are unanswered; all seven must be affirmed."
              : "Some attestations are declined; all seven must be affirmed.",
          { unanswered: missing, declined: denied },
        ),
  );

  findings.push(
    declaredAuthFinding(
      profile.declaredAuthMode,
      evidence.observedAuthMode,
      stamp,
    ),
  );

  findings.push(
    informational(
      ARTIFACT_QUALITY,
      stamp,
      {
        reviewItems: [
          "the screenshots show this connector rather than a generic UI",
          ...REVIEW_ITEMS,
        ],
        declaredDataHandling: profile.dataHandling,
      },
      REVIEW_NOTE,
    ),
  );

  return findings;
}

const REVIEW_ITEMS = [
  "the description matches what the tools actually do",
  "the submitter owns or is authorized for the service",
  "the privacy policy covers the declared data handling",
];
const REVIEW_NOTE =
  "These cannot be settled from the wire; a reviewer has to look.";

/** Answers each check owns, so one portal issue is reported by one check. */
const COPY_KEYS = [
  "listing.name",
  "listing.slug",
  "listing.oneLiner",
  "listing.description",
  "listing.categories",
  "listing.authorName",
];
const LINK_KEYS = [
  "listing.documentationUrl",
  "listing.privacyPolicyUrl",
  "listing.support",
  "listing.authorUrl",
  "listing.iconUrl",
  "listing.enterpriseAuthDocsUrl",
];
const ACKNOWLEDGMENTS_KEY = "compliance.acknowledgments";

function gradeAnswers(
  evidence: ClaudeSubmissionEvidence,
  answers: ClaudeAnswerEvidence,
  stamp: ClaudeCheckStamp,
): ClaudeReadinessFinding[] {
  const { values } = answers;
  const fields = (
    definition: ClaudeCheckDefinition,
    keys: readonly string[],
    details: Record<string, unknown>,
  ) => gradeOwnedAnswers(definition, answers, keys, stamp, details);
  const ticked = values[ACKNOWLEDGMENTS_KEY];
  const acknowledged = new Set<unknown>(Array.isArray(ticked) ? ticked : []);
  const acknowledgments =
    directoryFlowField(CLAUDE_CONNECTOR_FLOW, ACKNOWLEDGMENTS_KEY)?.options ??
    [];
  const lengthOf = (key: string) => {
    const value = values[key];
    return typeof value === "string" || Array.isArray(value)
      ? value.length
      : 0;
  };
  const noScreenshots = "an MCP connector submission has no screenshots";

  return [
    fields(LISTING_FIELDS, COPY_KEYS, {
      oneLinerLength: lengthOf("listing.oneLiner"),
      descriptionLength: lengthOf("listing.description"),
      categories: lengthOf("listing.categories"),
      limits: {
        oneLiner: CLAUDE_SUBMISSION_LIMITS.oneLinerMaxLength,
        description: CLAUDE_SUBMISSION_LIMITS.descriptionMaxLength,
        categoriesMax: CLAUDE_SUBMISSION_LIMITS.categoriesMax,
      },
    }),
    fields(LISTING_URLS, LINK_KEYS, {
      links: Object.fromEntries(LINK_KEYS.map((key) => [key, values[key]])),
    }),
    notApplicable(SCREENSHOTS, stamp, noScreenshots),
    notApplicable(SCREENSHOT_PROMPTS, stamp, noScreenshots),
    gradeOwnedAnswers(
      ATTESTATIONS,
      answers,
      [ACKNOWLEDGMENTS_KEY],
      stamp,
      {
        acknowledged: acknowledged.size,
        notAcknowledged: acknowledgments
          .filter((option) => !acknowledged.has(option.value))
          .map((option) => option.label),
      },
      unconfirmedProblems(answers, [ACKNOWLEDGMENTS_KEY])
    ),
    // A caller's own observation keeps its old meaning; otherwise the
    // answers are held against what the run saw of the server's sign-in.
    evidence.observedAuthMode === undefined
      ? compareAuthAnswersWithServer(
          DECLARED_AUTH_MATCHES,
          answers,
          evidence.auth,
          stamp
        )
      : declaredAuthFinding(
          answers.declaredAuthMode,
          evidence.observedAuthMode,
          stamp
        ),
    informational(
      ARTIFACT_QUALITY,
      stamp,
      {
        reviewItems: REVIEW_ITEMS,
        declaredDataHandling: {
          apiOwnership: values["dataHandling.apiOwnership"],
          healthData: values["dataHandling.healthData"],
          sponsored: values["dataHandling.sponsored"],
        },
      },
      REVIEW_NOTE,
    ),
  ];
}

function declaredAuthFinding(
  declared: string | undefined,
  observed: string | undefined,
  stamp: ClaudeCheckStamp,
): ClaudeReadinessFinding {
  if (declared === undefined) {
    return notEvaluated(
      DECLARED_AUTH_MATCHES,
      stamp,
      "the submission does not say how users authenticate",
    );
  }
  if (observed === undefined) {
    return notEvaluated(
      DECLARED_AUTH_MATCHES,
      stamp,
      "this run could not determine the server's authentication mode from the wire, so the declaration stands unchallenged",
      { declared },
    );
  }
  return contradicts(declared, observed)
    ? violated(
        DECLARED_AUTH_MATCHES,
        stamp,
        `The submission declares \`${declared}\` but this run observed \`${observed}\`. Correct whichever is wrong before submitting.`,
        { declared, observed },
      )
    : satisfied(DECLARED_AUTH_MATCHES, stamp, { declared, observed });
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Whether a declaration and an observation genuinely conflict.
 *
 * Only a positive contradiction counts. `authless` declared against observed
 * OAuth is a conflict; a declared `static-header` against an observation that
 * saw no OAuth is not — that is exactly what a static-header server looks
 * like from outside, and failing it would punish a truthful declaration.
 */
function contradicts(declared: string, observed: string): boolean {
  if (declared === observed) return false;
  const declaredIsOAuth = declared.startsWith("oauth-");
  const observedIsOAuth = observed.startsWith("oauth-");
  if (declaredIsOAuth !== observedIsOAuth) return true;
  // Two OAuth flavours that disagree — e.g. declared `oauth-dcr` while the
  // server offers only CIMD — is a real mismatch a reviewer will hit.
  return declaredIsOAuth && observedIsOAuth;
}
