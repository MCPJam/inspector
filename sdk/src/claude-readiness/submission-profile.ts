/**
 * The submission profile: what a submitter DECLARES, as opposed to what the
 * wire shows.
 *
 * WHY AN INPUT AT ALL. Half of Anthropic's directory requirements are about
 * artifacts a wire probe cannot see — a listing name, a tagline, screenshots,
 * a privacy policy URL, seven attestations. A runner with no access to those
 * has exactly two honest options: report the lane `incomplete` and name the
 * input it lacks, or say nothing. What it must never do is infer them.
 * `serverInfo.name` is NOT the listing name, and treating it as a proxy would
 * grade a field the submitter never filled in.
 *
 * WHAT THIS BUYS. With the profile supplied, presence, lengths, URL shapes and
 * image type/dimensions become DETERMINISTIC — pass or fail, no judgement. What
 * stays `manual-review` is everything the bytes cannot settle: whether a
 * screenshot shows the product, whether the submitter owns the domain, whether
 * an attestation is true. Provenance on those findings is `declared`, so no
 * reader can mistake "the submitter said so" for "we verified it".
 *
 * Pure schema. Safe from the browser entry.
 */

import { z } from "zod";

import { CLAUDE_SUBMISSION_LIMITS } from "./profile.js";

/**
 * How the connector authenticates, as DECLARED. A wire probe can often infer
 * this, but not always — a static-header credential and a custom connection
 * flow both look like "no OAuth" from outside — so the declaration is what
 * makes those cases classifiable instead of failures.
 */
export const CLAUDE_DECLARED_AUTH_MODES = [
  "oauth-dcr",
  "oauth-cimd",
  "oauth-preregistered",
  "static-header",
  "authless",
  "custom-connection",
] as const;

/** What the connector does with user data, as declared on the submission form. */
export const CLAUDE_DATA_HANDLING_MODES = [
  "no-user-data",
  "processes-user-data",
  "stores-user-data",
  "shares-with-third-parties",
] as const;

/**
 * The attestations the submission form requires.
 *
 * All seven are represented explicitly rather than as a count, so a profile
 * that is missing one names WHICH one. Every one of them is a claim about the
 * world that no probe can verify, which is why the checks over them are
 * presence checks and the truth of them stays `manual-review`.
 */
export const CLAUDE_ATTESTATIONS = [
  "ownsOrIsAuthorizedForService",
  "accurateDataHandlingDisclosure",
  "compliesWithUsagePolicies",
  "noProhibitedContent",
  "maintainsSecurityPractices",
  "respondsToSecurityReports",
  "keepsListingAccurate",
] as const;

const httpsUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith("https://"), {
    message: "must be an https:// URL",
  });

const screenshotSchema = z.object({
  /** Absolute URL or a data URI the caller has already resolved. */
  url: z.string().min(1),
  /** MIME type as served. Anthropic accepts PNG for listing screenshots. */
  mimeType: z.string().min(1),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  /**
   * The prompt this screenshot illustrates. Paired, not optional: a gallery of
   * screenshots with no prompts does not show a reviewer what the connector
   * does, which is the thing the requirement is for.
   */
  prompt: z.string().min(1),
});

export const claudeSubmissionProfileSchema = z.object({
  name: z.string().min(1).max(CLAUDE_SUBMISSION_LIMITS.nameMaxLength),
  tagline: z.string().min(1).max(CLAUDE_SUBMISSION_LIMITS.taglineMaxLength),
  description: z
    .string()
    .min(1)
    .max(CLAUDE_SUBMISSION_LIMITS.descriptionMaxLength),
  categories: z
    .array(z.string().min(1))
    .min(CLAUDE_SUBMISSION_LIMITS.categoriesMin)
    .max(CLAUDE_SUBMISSION_LIMITS.categoriesMax),
  /** URL-safe listing slug. */
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a lowercase kebab-case slug"),
  documentationUrl: httpsUrl,
  privacyPolicyUrl: httpsUrl,
  supportUrl: httpsUrl,
  iconUrl: httpsUrl,
  declaredAuthMode: z.enum(CLAUDE_DECLARED_AUTH_MODES),
  dataHandling: z.array(z.enum(CLAUDE_DATA_HANDLING_MODES)).min(1),
  screenshots: z
    .array(screenshotSchema)
    .min(CLAUDE_SUBMISSION_LIMITS.screenshotsMin)
    .max(CLAUDE_SUBMISSION_LIMITS.screenshotsMax),
  /**
   * Attestation → whether the submitter affirmed it. A missing key is not the
   * same as `false`: one is an incomplete form, the other is a refusal, and
   * the checks report them differently.
   */
  attestations: z.record(z.enum(CLAUDE_ATTESTATIONS), z.boolean()),
});

export type ClaudeSubmissionProfile = z.infer<
  typeof claudeSubmissionProfileSchema
>;
export type ClaudeDeclaredAuthMode =
  (typeof CLAUDE_DECLARED_AUTH_MODES)[number];
export type ClaudeDataHandlingMode = (typeof CLAUDE_DATA_HANDLING_MODES)[number];
export type ClaudeAttestation = (typeof CLAUDE_ATTESTATIONS)[number];

/**
 * A profile that failed validation, kept rather than discarded.
 *
 * A caller who supplied a malformed profile has NOT supplied no profile, and
 * reporting the lane as "no input" would hide their mistake behind a status
 * that reads like our limitation. The issues are surfaced as findings instead.
 */
export interface ClaudeSubmissionProfileParse {
  profile?: ClaudeSubmissionProfile;
  issues: string[];
}

export function parseClaudeSubmissionProfile(
  input: unknown,
): ClaudeSubmissionProfileParse {
  const parsed = claudeSubmissionProfileSchema.safeParse(input);
  if (parsed.success) return { profile: parsed.data, issues: [] };
  return {
    issues: parsed.error.issues.map(
      (issue) =>
        `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    ),
  };
}
