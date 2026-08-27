/**
 * Submission-artifact checks.
 *
 * THE LANE IS DISPOSITIVE, AND THAT IS THE POINT. A submission missing its test
 * cases, its attestations or its domain verification is not ready, and grading
 * those as non-blocking suggestions would misrepresent the directory. But a
 * submitter running a quick technical check on their server has supplied no
 * profile, and failing that run on paperwork they have not written yet would
 * make the quick check useless.
 *
 * The staged rollup is what resolves it. This lane belongs to
 * `submission-ready` and not to `technical-preflight`, so a profile-less run is
 * honestly `ready` at the narrow stage and `incomplete` at the broad one — both
 * statements true, neither one softened.
 *
 * THE OTHER SPLIT, inside the lane:
 *
 *   - DETERMINISTIC — presence, counts, lengths, URL shapes, enum membership.
 *     `required`, and they pass or fail on what was declared.
 *   - MANUAL — whether a failure case really fails GRACEFULLY, whether the
 *     submitter owns the domain, whether an attestation is true. These are
 *     `manual-review` with `declared` provenance, so no reader can mistake
 *     "the submitter said so" for "we checked".
 *
 * Pure data. No transport.
 */

import { openaiPolicySource } from "../manifest.js";
import { OPENAI_SUBMISSION_TEST_CASES } from "../profile.js";
import {
  OPENAI_ATTESTATIONS,
  summarizeTestCases,
  type OpenAISubmissionProfile,
} from "../submission-profile.js";
import {
  OPENAI_READINESS_INPUTS,
  type OpenAIReadinessFinding,
} from "../types.js";
import {
  missingInput,
  notApplicable,
  notEvaluated,
  satisfied,
  violated,
  type OpenAICheckDefinition,
  type OpenAICheckStamp,
} from "./helpers.js";

export interface OpenAISubmissionEvidence {
  profile?: OpenAISubmissionProfile;
  /** Validation issues from a profile that was supplied and was malformed. */
  profileIssues: string[];
  /** Tool names observed with a destructive or open-world annotation. */
  annotatedTools?: string[];
  /** UI frame domains observed on the wire. */
  frameDomains?: string[];
  /**
   * Whether a version is already published, as the RUNNER resolved it.
   *
   * Threaded in rather than read off `profile.hasPublishedVersion`, because the
   * profile is only one of the two places that fact can come from — a caller
   * with no profile may state it directly — and the lane gate already resolves
   * both. Reading the profile field here would let this module call a run a
   * first submission while the release-contract lane grades it as an update.
   */
  hasPublishedVersion?: boolean;
}

const LISTING_FIELDS: OpenAICheckDefinition = {
  id: "openai.submission.listing-fields",
  title: "Listing name, descriptions and categories are within limits",
  lane: "submission-artifacts",
  class: "required",
  source: openaiPolicySource("deploy/submission", "§Listing details"),
  provenance: "declared",
  intrusiveness: "passive",
};

const LISTING_URLS: OpenAICheckDefinition = {
  id: "openai.submission.urls",
  title: "Privacy policy and support URLs are HTTPS",
  lane: "submission-artifacts",
  class: "required",
  source: openaiPolicySource("deploy/submission", "§Listing details → Links"),
  provenance: "declared",
  intrusiveness: "passive",
};

const TEST_CASES: OpenAICheckDefinition = {
  id: "openai.submission.test-cases",
  title: `${OPENAI_SUBMISSION_TEST_CASES.successCount} successful and ${OPENAI_SUBMISSION_TEST_CASES.failureCount} graceful-failure test cases are supplied`,
  lane: "submission-artifacts",
  class: "required",
  source: openaiPolicySource("deploy/submission", "§Test cases"),
  provenance: "declared",
  intrusiveness: "passive",
};

const TEST_CASE_QUALITY: OpenAICheckDefinition = {
  id: "openai.submission.test-case-quality",
  title: "The failure cases actually degrade gracefully",
  lane: "experience-insights",
  class: "manual-review",
  source: openaiPolicySource("app-guidelines", "§Predictable behaviour"),
  provenance: "declared",
  intrusiveness: "passive",
};

const DEMO_ACCESS: OpenAICheckDefinition = {
  id: "openai.submission.demo-access",
  title: "Reviewer demo credentials and a demo recording are provided",
  lane: "submission-artifacts",
  class: "required",
  source: openaiPolicySource("deploy/submission", "§Demo access"),
  provenance: "declared",
  intrusiveness: "passive",
};

const ACCOUNT: OpenAICheckDefinition = {
  id: "openai.submission.account",
  title: "The submitting account is identity-verified and holds app-write",
  lane: "submission-artifacts",
  class: "required",
  source: openaiPolicySource("deploy/submission", "§Account requirements"),
  provenance: "declared",
  intrusiveness: "passive",
};

const GEOGRAPHY: OpenAICheckDefinition = {
  id: "openai.submission.geography",
  title: "Country availability is declared",
  lane: "submission-artifacts",
  class: "required",
  source: openaiPolicySource("deploy/submission", "§Availability"),
  provenance: "declared",
  intrusiveness: "passive",
};

const RELEASE_NOTES: OpenAICheckDefinition = {
  id: "openai.submission.release-notes",
  title: "An updated submission supplies release notes",
  lane: "submission-artifacts",
  class: "required",
  source: openaiPolicySource("deploy/submission", "§Release notes"),
  provenance: "declared",
  intrusiveness: "passive",
};

const ATTESTATIONS: OpenAICheckDefinition = {
  id: "openai.submission.attestations",
  title: "Every policy attestation is affirmed",
  lane: "submission-artifacts",
  class: "required",
  source: openaiPolicySource("deploy/submission", "§Attestations"),
  provenance: "declared",
  intrusiveness: "passive",
};

const ATTESTATION_TRUTH: OpenAICheckDefinition = {
  id: "openai.submission.attestation-truth",
  title: "The attestations are true",
  lane: "experience-insights",
  class: "manual-review",
  source: openaiPolicySource("app-guidelines", "§Trust"),
  provenance: "declared",
  intrusiveness: "passive",
};

const DOMAIN_TOKEN: OpenAICheckDefinition = {
  id: "openai.submission.domain-token",
  title: "A domain-verification token is on file",
  lane: "submission-artifacts",
  class: "required",
  source: openaiPolicySource("deploy/submission", "§Domain verification"),
  provenance: "declared",
  intrusiveness: "passive",
};

/**
 * WHAT THIS CHECK CLAIMS, and what it deliberately does not.
 *
 * It used to be titled "the draft's tool scan is CURRENT" while testing only
 * that a timestamp exists — so a scan from six months ago passed a `required`
 * check about currency. The title has been brought down to what the profile
 * can actually establish.
 *
 * Currency in the real sense means the scan postdates the server contract it
 * describes, and deciding that needs BOTH the scan time and the contract's —
 * which is the release-contract lane's evidence, not this one's. Rather than
 * invent a staleness window and present the number as OpenAI's, this grades the
 * two things the profile does settle: that a scan happened at all, and that its
 * timestamp is not in the future — a value that postdates the run cannot
 * describe a scan that has already happened, so it is a clock or a
 * copy-paste, and either way the date is not evidence of anything.
 */
const SCAN_CURRENCY: OpenAICheckDefinition = {
  id: "openai.submission.scan-currency",
  title: "A tool scan is recorded for the draft, dated no later than this run",
  lane: "submission-artifacts",
  class: "required",
  source: openaiPolicySource("deploy/submission", "§Scan tools"),
  provenance: "declared",
  intrusiveness: "passive",
};

const PRIVACY_DISCLOSURE: OpenAICheckDefinition = {
  id: "openai.submission.privacy-disclosure",
  title: "Declared data types are consistent with the privacy policy",
  lane: "experience-insights",
  class: "manual-review",
  source: openaiPolicySource("app-guidelines", "§Privacy"),
  provenance: "declared",
  intrusiveness: "passive",
};

const ANNOTATION_JUSTIFICATIONS: OpenAICheckDefinition = {
  id: "openai.submission.annotation-justifications",
  title: "Destructive and open-world tools carry a justification for review",
  lane: "submission-artifacts",
  class: "recommended",
  source: openaiPolicySource("deploy/submission", "§Test cases"),
  provenance: "declared",
  intrusiveness: "passive",
};

const FRAME_DOMAIN_EXPLANATIONS: OpenAICheckDefinition = {
  id: "openai.submission.frame-domain-explanations",
  title: "Every embedded frame domain is explained",
  lane: "submission-artifacts",
  class: "recommended",
  source: openaiPolicySource("concepts/ui-guidelines", "§Embedded content"),
  provenance: "declared",
  intrusiveness: "passive",
};

const PROFILE_VALID: OpenAICheckDefinition = {
  id: "openai.submission.profile-valid",
  title: "The supplied submission profile is well-formed",
  lane: "submission-artifacts",
  class: "required",
  source: openaiPolicySource("deploy/submission", "§Submission form"),
  provenance: "declared",
  intrusiveness: "passive",
};

/** Every check in this module, so a profile-less run reports all of them. */
const ALL_CHECKS: OpenAICheckDefinition[] = [
  LISTING_FIELDS,
  LISTING_URLS,
  TEST_CASES,
  TEST_CASE_QUALITY,
  DEMO_ACCESS,
  ACCOUNT,
  GEOGRAPHY,
  RELEASE_NOTES,
  ATTESTATIONS,
  ATTESTATION_TRUTH,
  DOMAIN_TOKEN,
  SCAN_CURRENCY,
  PRIVACY_DISCLOSURE,
  ANNOTATION_JUSTIFICATIONS,
  FRAME_DOMAIN_EXPLANATIONS,
];

const REQUIRED_ACCOUNT_PERMISSION = "api.apps.write";

export function runOpenAISubmissionChecks(
  evidence: OpenAISubmissionEvidence,
  stamp: OpenAICheckStamp,
): OpenAIReadinessFinding[] {
  const findings: OpenAIReadinessFinding[] = [];
  const { profile } = evidence;

  // A malformed profile is a caller's mistake, reported as one. Routing it down
  // the "no input" branch would hide it behind a status that reads like our
  // limitation.
  if (evidence.profileIssues.length > 0) {
    findings.push(
      violated(
        PROFILE_VALID,
        stamp,
        `The submission profile did not validate: ${evidence.profileIssues.slice(0, 3).join("; ")}${
          evidence.profileIssues.length > 3 ? "…" : ""
        }`,
        { issues: evidence.profileIssues },
      ),
    );
  } else if (profile) {
    findings.push(satisfied(PROFILE_VALID, stamp));
  }

  if (!profile) {
    for (const definition of ALL_CHECKS) {
      findings.push(
        notEvaluated(
          definition,
          stamp,
          "no submission profile was supplied, and none of this can be observed from the server or the package",
          missingInput(OPENAI_READINESS_INPUTS.submissionProfile),
        ),
      );
    }
    return findings;
  }

  // ------------------------------------------------------------ the listing
  findings.push(
    satisfied(LISTING_FIELDS, stamp, {
      // The schema already enforced the bounds, so reaching here IS the pass.
      // Recording the values makes the pass auditable rather than asserted.
      name: profile.name.length,
      shortDescription: profile.shortDescription.length,
      description: profile.description.length,
      categories: profile.categories,
    }),
  );
  findings.push(
    // As above: the profile schema types both fields as `httpsUrl`, which
    // refines a parsed URL down to an `https://` prefix, so a profile carrying
    // an `http://` support URL never reaches this function — it fails to parse
    // and the whole lane reports the schema error instead. Reaching here IS
    // the pass; the values are recorded so it is auditable rather than
    // asserted.
    satisfied(LISTING_URLS, stamp, {
      privacyPolicyUrl: profile.privacyPolicyUrl,
      supportUrl: profile.supportUrl,
    }),
  );

  // --------------------------------------------------------- review materials
  const tests = summarizeTestCases(profile);
  if (tests.meetsSuccessMinimum && tests.meetsFailureMinimum) {
    findings.push(satisfied(TEST_CASES, stamp, tests));
  } else {
    findings.push(
      violated(
        TEST_CASES,
        stamp,
        `Supply at least ${OPENAI_SUBMISSION_TEST_CASES.successCount} successful and ` +
          `${OPENAI_SUBMISSION_TEST_CASES.failureCount} graceful-failure test cases; ` +
          `this profile has ${tests.successful} and ${tests.gracefulFailure}.`,
        tests,
      ),
    );
  }
  findings.push(
    notEvaluated(
      TEST_CASE_QUALITY,
      stamp,
      "whether a case degrades gracefully is a judgement about the response, which this run cannot make from a declared prompt and expectation",
      { declaredFailureCases: profile.testCases.gracefulFailure.length },
    ),
  );

  const needsCredentials =
    profile.demoCredentials.delivery !== "not-required-authless";
  const demoProblems: string[] = [];
  if (needsCredentials && !profile.demoCredentials.provided) {
    demoProblems.push("reviewer demo credentials are not provided");
  }
  if (!profile.demoRecordingProvided) {
    demoProblems.push("no demo recording is provided");
  }
  findings.push(
    demoProblems.length === 0
      ? satisfied(DEMO_ACCESS, stamp, {
          delivery: profile.demoCredentials.delivery,
          recording: profile.demoRecordingProvided,
        })
      : violated(
          DEMO_ACCESS,
          stamp,
          `Reviewers cannot exercise the plugin: ${demoProblems.join(", ")}.`,
          {
            delivery: profile.demoCredentials.delivery,
            recording: profile.demoRecordingProvided,
          },
        ),
  );

  // -------------------------------------------------------------- the account
  const accountProblems: string[] = [];
  if (!profile.identityVerified) {
    accountProblems.push("the account is not identity-verified");
  }
  if (!profile.accountPermissions.includes(REQUIRED_ACCOUNT_PERMISSION)) {
    accountProblems.push(`the account lacks ${REQUIRED_ACCOUNT_PERMISSION}`);
  }
  findings.push(
    accountProblems.length === 0
      ? satisfied(ACCOUNT, stamp, {
          permissions: profile.accountPermissions,
        })
      : violated(ACCOUNT, stamp, `${accountProblems.join("; ")}.`, {
          permissions: profile.accountPermissions,
        }),
  );

  // ------------------------------------------------------------- availability
  findings.push(
    profile.availableCountries.length > 0
      ? satisfied(GEOGRAPHY, stamp, {
          countries: profile.availableCountries.length,
        })
      : violated(
          GEOGRAPHY,
          stamp,
          "Declare the countries this listing will be available in.",
        ),
  );

  // ------------------------------------------------------------ release notes
  //
  // Only an UPDATE needs them. Requiring release notes on a first submission
  // would fail every plugin's first attempt on a field that has nothing to
  // describe.
  findings.push(
    !(evidence.hasPublishedVersion ?? profile.hasPublishedVersion)
      ? notApplicable(
          RELEASE_NOTES,
          stamp,
          "this is a first submission, so there is no previous version for release notes to describe",
        )
      : profile.releaseNotes
        ? satisfied(RELEASE_NOTES, stamp)
        : violated(
            RELEASE_NOTES,
            stamp,
            "An update to a published plugin must supply release notes.",
          ),
  );

  // ------------------------------------------------------------ attestations
  const missing = OPENAI_ATTESTATIONS.filter(
    (attestation) => profile.attestations[attestation] !== true,
  );
  findings.push(
    missing.length === 0
      ? satisfied(ATTESTATIONS, stamp, {
          affirmed: OPENAI_ATTESTATIONS.length,
        })
      : violated(
          ATTESTATIONS,
          stamp,
          `Affirm the remaining attestation(s): ${missing.join(", ")}.`,
          {
            // Which ones, not how many: "3 missing" sends a submitter back to
            // read the whole form.
            missing,
            // A key that is present and `false` is a REFUSAL; an absent key is
            // an unfinished form. Different problems, so they are recorded
            // apart even though both fail the check.
            refused: missing.filter(
              (attestation) => profile.attestations[attestation] === false,
            ),
          },
        ),
  );
  findings.push(
    notEvaluated(
      ATTESTATION_TRUTH,
      stamp,
      "an attestation is a claim about the world; this run can see that it was affirmed and nothing more",
    ),
  );

  // ------------------------------------------------------- domain and scanning
  findings.push(
    profile.domainVerificationToken
      ? satisfied(DOMAIN_TOKEN, stamp)
      : violated(
          DOMAIN_TOKEN,
          stamp,
          "Record the domain-verification token the portal issued, so the well-known challenge can be checked.",
        ),
  );
  // A TIMESTAMP THAT DOES NOT PARSE IS NOT A TIMESTAMP. `Date.parse` answers
  // `NaN` rather than throwing, and `NaN > runAt` is `false` — so an unreadable
  // value would slide past the future-date test into `satisfied`, with the
  // `ageMs` it could not compute quietly absent. The profile schema types this
  // field as an ISO-8601 datetime and rejects every unparseable string I could
  // find, so this is belt-and-braces rather than a live hole; it is here
  // because the function is exported, its parameter says only `string`, and a
  // caller who skips the schema should not get a pass out of it.
  const scannedAt = profile.lastScanAt
    ? Date.parse(profile.lastScanAt)
    : undefined;
  const runAt = Date.parse(stamp.evaluatedAt);
  const datesReadable =
    scannedAt !== undefined &&
    Number.isFinite(scannedAt) &&
    Number.isFinite(runAt);

  findings.push(
    profile.lastScanAt
      ? !datesReadable
        ? notEvaluated(
            SCAN_CURRENCY,
            stamp,
            `the recorded scan time is not a readable date, so this run cannot tell when the scan happened: ${JSON.stringify(profile.lastScanAt)}`,
          )
        : scannedAt > runAt
          ? violated(
              SCAN_CURRENCY,
              stamp,
              "The recorded scan time is later than this run, so it cannot describe a scan that has already happened; rescan and record the new timestamp.",
              {
                lastScanAt: profile.lastScanAt,
                evaluatedAt: stamp.evaluatedAt,
              },
            )
          : satisfied(SCAN_CURRENCY, stamp, {
              lastScanAt: profile.lastScanAt,
              // The age, so a reader can judge staleness this check does not
              // decide — see the definition's note on why it does not.
              ageMs: runAt - scannedAt,
            })
      : notEvaluated(
          SCAN_CURRENCY,
          stamp,
          "the profile records no scan timestamp, so this run cannot tell whether the draft's scan predates the current server contract",
          missingInput(OPENAI_READINESS_INPUTS.submissionProfile, {
            field: "lastScanAt",
          }),
        ),
  );

  // -------------------------------------------------------------- disclosures
  findings.push(
    notEvaluated(
      PRIVACY_DISCLOSURE,
      stamp,
      "whether the declared data types match what the privacy policy says needs a person to read both",
      { declaredDataTypes: profile.privacyPolicyDataTypes },
    ),
  );

  const annotated = evidence.annotatedTools ?? [];
  const unjustified = annotated.filter(
    (tool) => !profile.annotationJustifications[tool],
  );
  findings.push(
    annotated.length === 0
      ? notApplicable(
          ANNOTATION_JUSTIFICATIONS,
          stamp,
          "no tool was observed carrying a destructive or open-world annotation",
        )
      : unjustified.length === 0
        ? satisfied(ANNOTATION_JUSTIFICATIONS, stamp, { annotated })
        : violated(
            ANNOTATION_JUSTIFICATIONS,
            stamp,
            `Explain why these tools are destructive or open-world: ${unjustified.join(", ")}.`,
            { annotated, unjustified },
          ),
  );

  const frameDomains = evidence.frameDomains ?? [];
  const unexplained = frameDomains.filter(
    (domain) => !profile.frameDomainExplanations[domain],
  );
  findings.push(
    frameDomains.length === 0
      ? notApplicable(
          FRAME_DOMAIN_EXPLANATIONS,
          stamp,
          "this submission embeds no frame domains",
        )
      : unexplained.length === 0
        ? satisfied(FRAME_DOMAIN_EXPLANATIONS, stamp, { frameDomains })
        : violated(
            FRAME_DOMAIN_EXPLANATIONS,
            stamp,
            `Explain why these frame domains are embedded: ${unexplained.join(", ")}.`,
            { frameDomains, unexplained },
          ),
  );

  return findings;
}
