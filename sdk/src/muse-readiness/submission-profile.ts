/**
 * The Muse submission profile: what a submitter DECLARES, as opposed to what
 * the wire shows.
 *
 * WHY AN INPUT AT ALL. Section 5 of Meta's guidelines is a list of things a
 * submitter hands over — an overview, contacts, documentation, credentials, a
 * test account — and none of it is visible on the wire. Without this profile
 * the submission lane reports `incomplete` and names the input; it never
 * infers a field.
 *
 * EVERY FIELD IS OPTIONAL, unlike Claude's all-or-nothing profile, and that is
 * deliberate. Muse's form is filled in over several sittings and the most
 * useful thing to check first — the per-tool classification — is one field. A
 * missing field in a SUPPLIED profile is graded by the check that needs it
 * (`violated`, naming the field), so a partial profile still grades what it
 * holds. Only a profile that is not an object at all, or whose fields have the
 * wrong TYPE, fails to parse.
 *
 * URLs and contacts are plain strings here and validated by the checks: a bad
 * URL is a finding a submitter can act on, not a parse error that hides every
 * other field.
 *
 * Pure schema. Safe from the browser entry.
 */

import { z } from "zod";

import {
  MUSE_ATTESTATIONS,
  MUSE_AUTH_METHODS,
  MUSE_CREDENTIAL_ENVIRONMENTS,
  MUSE_DOCUMENTATION_TOPICS,
  MUSE_TOOL_CLASSES,
} from "./profile.js";

const text = z.string();

export const museSubmissionProfileSchema = z.object({
  /** §5.1 Connector overview, and §4.3's restriction disclosure. */
  overview: z
    .object({
      intendedUsers: text.optional(),
      supportedTasks: z.array(text).optional(),
      /** §1.2: how the connector improves on what Muse's browser already does. */
      browserImprovement: text.optional(),
      /**
       * Account, plan, region, age and usage restrictions (§4.3, §5.1). Write
       * "none" when there are none — an empty answer and "no restrictions"
       * are different statements.
       */
      restrictions: text.optional(),
    })
    .optional(),

  /** §5.2: privacy and product terms, support and security contacts. */
  privacyPolicyUrl: text.optional(),
  termsUrl: text.optional(),
  /** An https URL or an email address. */
  supportContact: text.optional(),
  /** An https URL or an email address. */
  securityContact: text.optional(),

  /** §5.4: the API/MCP documentation and what it covers. */
  documentationUrl: text.optional(),
  documentationCovers: z.array(z.enum(MUSE_DOCUMENTATION_TOPICS)).optional(),

  /** §5.4 integration credentials, and §3.1's read-only option. */
  authentication: z
    .object({
      method: z.enum(MUSE_AUTH_METHODS),
      /** Every scope Muse will request (§5.4 "requested scopes"). */
      scopes: z.array(text).optional(),
      /** The scope set that limits Muse to Read Only (§3.1). */
      readOnlyScopes: z.array(text).optional(),
      /** Why a read-only option is not possible, when it is not (§3.1 "where possible"). */
      readOnlyNotPossibleReason: text.optional(),
      credentialsEnvironment: z.enum(MUSE_CREDENTIAL_ENVIRONMENTS).optional(),
    })
    .optional(),

  /** §5.5 test user credentials. Credentials themselves never belong here. */
  testAccount: z
    .object({
      signInInstructions: text.optional(),
      requiredPermissions: text.optional(),
      representativeTestData: text.optional(),
      /** Account or regional limits; "none" when there are none. */
      limits: text.optional(),
      accessibleThroughoutReview: z.boolean().optional(),
    })
    .optional(),

  /** §5.5 "For transaction tools, explain how to test checkout without real charges." */
  transactions: z
    .object({
      hasTransactionTools: z.boolean(),
      noChargeTestPath: text.optional(),
    })
    .optional(),

  /**
   * §5.6: the Read / Write / Sensitive-write class of every tool, by tool
   * name — what the portal will take directly once it can, and what the
   * documentation must carry until then.
   */
  toolClassifications: z.record(text, z.enum(MUSE_TOOL_CLASSES)).optional(),

  /**
   * Attestation → whether the submitter affirmed it. A missing key is an
   * incomplete form; `false` is a refusal. The check reports them differently.
   *
   * `partialRecord`, not `record`: in zod 4 a record keyed by an enum is
   * EXHAUSTIVE, so a profile missing one attestation would fail to parse and
   * take every other field down with it instead of naming the missing one.
   */
  attestations: z
    .partialRecord(z.enum(MUSE_ATTESTATIONS), z.boolean())
    .optional(),
});

export type MuseSubmissionProfile = z.infer<typeof museSubmissionProfileSchema>;

/**
 * A profile that failed validation, kept rather than discarded: a caller who
 * supplied a malformed profile has not supplied no profile, and the issues
 * become the reason on every finding that needed it.
 */
export interface MuseSubmissionProfileParse {
  profile?: MuseSubmissionProfile;
  issues: string[];
}

export function parseMuseSubmissionProfile(
  input: unknown
): MuseSubmissionProfileParse {
  const parsed = museSubmissionProfileSchema.safeParse(input);
  if (parsed.success) return { profile: parsed.data, issues: [] };
  return {
    issues: parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`
    ),
  };
}
