/**
 * The submission profile: what a submitter DECLARES, as opposed to what the
 * wire or the package shows.
 *
 * WHY AN INPUT AT ALL. Most of what the portal collects is invisible to a
 * probe — a listing description, eight test cases, a demo recording, a set of
 * attestations, a country list. A runner with no access to those has exactly
 * two honest options: report the lane `incomplete` and name the input it lacks,
 * or say nothing. What it must never do is infer them. A server's advertised
 * `serverInfo.name` is not a listing name, and treating it as a proxy would
 * grade a field the submitter never filled in.
 *
 * WHAT NEVER GOES IN HERE. Secrets. `demoCredentials` records that reviewer
 * credentials EXIST and how they are delivered — never a username, never a
 * password, never a token. A readiness profile is a document people paste into
 * issues and CI logs, and a schema that accepted a password would eventually be
 * handed one.
 *
 * WHAT THIS BUYS. With the profile supplied, presence, counts, lengths and URL
 * shapes become DETERMINISTIC — pass or fail, no judgement. What stays
 * `manual-review` is everything the bytes cannot settle: whether a test case
 * really fails gracefully, whether the submitter owns the domain, whether an
 * attestation is true. Provenance on those findings is `declared`, so no reader
 * can mistake "the submitter said so" for "we verified it".
 *
 * Pure schema. Safe from the browser entry.
 */

import { z } from "zod";

import {
  OPENAI_FIELD_LIMITS,
  OPENAI_LISTING_CATEGORIES,
  OPENAI_SUBMISSION_TEST_CASES,
} from "./profile.js";

/**
 * The attestations the submission form requires.
 *
 * Represented explicitly rather than as a count, so a profile missing one names
 * WHICH one. Every one is a claim about the world that no probe can verify,
 * which is why the checks over them are presence checks and their truth stays
 * `manual-review`.
 */
export const OPENAI_ATTESTATIONS = [
  "ownsOrIsAuthorizedForService",
  "accurateDataDisclosure",
  "compliesWithUsagePolicies",
  "noProhibitedContent",
  "maintainsSecurityPractices",
  "respondsToSecurityReports",
  "keepsListingAccurate",
] as const;

export type OpenAIAttestation = (typeof OPENAI_ATTESTATIONS)[number];

/** What the plugin does with user data, as declared on the submission form. */
export const OPENAI_DATA_TYPES = [
  "none",
  "account-identifiers",
  "user-content",
  "usage-analytics",
  "payment-information",
  "location",
  "health",
  "shared-with-third-parties",
] as const;

export type OpenAIDataType = (typeof OPENAI_DATA_TYPES)[number];

/** How reviewer demo access is delivered. Never the credential itself. */
export const OPENAI_DEMO_CREDENTIAL_DELIVERY = [
  "in-submission-form",
  "shared-out-of-band",
  "not-required-authless",
] as const;

const httpsUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith("https://"), {
    message: "must be an https:// URL",
  });

/**
 * One test case the reviewer will run.
 *
 * `expectation` is required on both kinds. A failing case with no stated
 * expectation is indistinguishable from a bug report, and the whole point of
 * the three failure cases is to show that the plugin degrades in a way the
 * submitter INTENDED.
 */
const testCaseSchema = z.object({
  prompt: z.string().min(1),
  expectation: z.string().min(1),
});

const screenshotSchema = z.object({
  /** Absolute URL, or a package-relative path the reader already resolved. */
  reference: z.string().min(1),
  mimeType: z.string().min(1),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  /** The prompt this screenshot illustrates. */
  prompt: z.string().min(1),
});

export const openaiSubmissionProfileSchema = z.object({
  // ------------------------------------------------------------ the listing
  name: z.string().min(1).max(OPENAI_FIELD_LIMITS.nameMaxLength),
  shortDescription: z
    .string()
    .min(1)
    .max(OPENAI_FIELD_LIMITS.shortDescriptionMaxLength),
  description: z.string().min(1).max(OPENAI_FIELD_LIMITS.descriptionMaxLength),
  /** Closed enum: a category outside the supported set is rejected. */
  categories: z.array(z.enum(OPENAI_LISTING_CATEGORIES)).min(1),
  privacyPolicyUrl: httpsUrl,
  supportUrl: httpsUrl,
  documentationUrl: httpsUrl.optional(),

  // ------------------------------------------------------- review materials
  /**
   * Both kinds, counted separately.
   *
   * Five that succeed and three that fail gracefully. Collapsing them into one
   * total of eight would let a submitter satisfy the requirement with eight
   * happy paths, and the failure cases are the ones the requirement is for.
   */
  testCases: z.object({
    successful: z.array(testCaseSchema),
    gracefulFailure: z.array(testCaseSchema),
  }),
  /**
   * That reviewer credentials exist and how they reach the reviewer. NEVER the
   * credential — see the module docblock.
   */
  demoCredentials: z.object({
    provided: z.boolean(),
    delivery: z.enum(OPENAI_DEMO_CREDENTIAL_DELIVERY),
  }),
  demoRecordingProvided: z.boolean(),
  screenshots: z.array(screenshotSchema).default([]),
  /** Required on an update; meaningless on a first submission. */
  releaseNotes: z.string().min(1).optional(),

  // -------------------------------------------------------------- the account
  identityVerified: z.boolean(),
  /** Scopes the submitting account holds, e.g. `api.apps.write`. */
  accountPermissions: z.array(z.string().min(1)).default([]),

  // ------------------------------------------------------------- availability
  /** ISO 3166-1 alpha-2 codes the listing will be available in. */
  availableCountries: z.array(z.string().length(2)).default([]),
  dataResidencyEligible: z.boolean().optional(),

  // -------------------------------------------------------------- disclosures
  privacyPolicyDataTypes: z.array(z.enum(OPENAI_DATA_TYPES)).default([]),
  /**
   * Tool name → why it is annotated destructive or open-world.
   *
   * A map rather than a list so a justification cannot drift away from the tool
   * it justifies.
   */
  annotationJustifications: z.record(z.string(), z.string().min(1)).default({}),
  /** UI frame domain → why the plugin needs to embed it. */
  frameDomainExplanations: z.record(z.string(), z.string().min(1)).default({}),

  // ------------------------------------------------------------- the server
  /** The token the portal issued for the well-known challenge path. */
  domainVerificationToken: z.string().min(1).optional(),
  /**
   * When the submitter last ran Scan Tools, ISO-8601.
   *
   * Compared against the draft snapshot rather than to "now": a scan is stale
   * relative to a CONTRACT CHANGE, not to the calendar, and failing a plugin
   * because nobody rescanned an unchanged server would be noise.
   */
  lastScanAt: z.string().datetime().optional(),
  /**
   * Whether a version of this plugin is already published.
   *
   * OPTIONAL, NOT `.default(false)`. A default here answers a question the
   * submitter never answered, and the runner is written to fall back to the
   * gathered evidence (`?? evidence.hasPublishedVersion`) precisely when the
   * profile is silent — a default makes that fallback unreachable. The cost is
   * specific: an update whose profile omits this field would grade as a first
   * submission, the release-contract lane would drop out of the stage as
   * `not-applicable`, and a change that breaks the published tool contract
   * would roll up `ready`.
   */
  hasPublishedVersion: z.boolean().optional(),

  /**
   * Attestation → whether the submitter affirmed it.
   *
   * PARTIAL on purpose. `z.record` over an enum key is EXHAUSTIVE in zod 4, so
   * an attestation map missing a key fails to parse — and a half-ticked form is
   * precisely the state a preflight exists to grade. Rejecting it would report
   * "malformed profile" for a submitter who has simply not finished, and would
   * make the distinction the check draws impossible to express: an absent key
   * is an unfinished form, a key present and `false` is a refusal, and the two
   * are different problems.
   */
  attestations: z.partialRecord(z.enum(OPENAI_ATTESTATIONS), z.boolean()),
});

export type OpenAISubmissionProfile = z.infer<
  typeof openaiSubmissionProfileSchema
>;

/**
 * A profile that failed validation, kept rather than discarded.
 *
 * A caller who supplied a malformed profile has NOT supplied no profile, and
 * reporting the lane as "no input" would hide their mistake behind a status
 * that reads like our limitation. The issues surface as findings instead.
 */
export interface OpenAISubmissionProfileParse {
  profile?: OpenAISubmissionProfile;
  issues: string[];
}

export function parseOpenAISubmissionProfile(
  input: unknown,
): OpenAISubmissionProfileParse {
  const parsed = openaiSubmissionProfileSchema.safeParse(input);
  if (parsed.success) return { profile: parsed.data, issues: [] };
  return {
    issues: parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    ),
  };
}

/** The counts the test-case requirement is actually about. */
export function summarizeTestCases(profile: OpenAISubmissionProfile): {
  successful: number;
  gracefulFailure: number;
  meetsSuccessMinimum: boolean;
  meetsFailureMinimum: boolean;
} {
  const successful = profile.testCases.successful.length;
  const gracefulFailure = profile.testCases.gracefulFailure.length;
  return {
    successful,
    gracefulFailure,
    meetsSuccessMinimum:
      successful >= OPENAI_SUBMISSION_TEST_CASES.successCount,
    meetsFailureMinimum:
      gracefulFailure >= OPENAI_SUBMISSION_TEST_CASES.failureCount,
  };
}
