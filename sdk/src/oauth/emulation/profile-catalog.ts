/**
 * OAuth client profile catalog — wire schema and digest (HP-43 step 3).
 *
 * The emulation engine is public; the client identities it emulates are not.
 * This module is the seam: the envelope shape the private backend serves, and
 * the validation the SDK applies before trusting any of it.
 *
 * See docs/host-oauth-profiles/profile-catalog-contract.md for the contract
 * this implements, including why there is deliberately no bundled fallback.
 */

import { z } from "zod";
import { canonicalizeOAuthProfile } from "../../host-config/canonicalize.js";
import { sha256Hex } from "../../host-config/hash.js";
import type { HostConfigOAuthProfile } from "../../host-config/types.js";

/**
 * The envelope version this SDK understands. Unlike the host-compat catalog,
 * an unknown version is NOT absorbed: there is no bundled fallback to degrade
 * to, so a profile this SDK cannot correctly interpret must fail rather than
 * be partially applied to a client emulation.
 */
export const SUPPORTED_OAUTH_PROFILE_SCHEMA_VERSION = 1;

/** Catalog listing entry — metadata only, never a profile body. */
export const oauthProfileSummarySchema = z.object({
  clientId: z.string().min(1),
  label: z.string().min(1).optional(),
  clientVersion: z.string().min(1).optional(),
  profileDigest: z.string().min(1),
  capturedAt: z.string().min(1).optional(),
});

export type OAuthProfileSummary = z.infer<typeof oauthProfileSummarySchema>;

export const oauthProfileListEnvelopeSchema = z.object({
  schemaVersion: z.literal(SUPPORTED_OAUTH_PROFILE_SCHEMA_VERSION),
  catalogRevision: z.string().min(1),
  entries: z.array(oauthProfileSummarySchema),
});

export type OAuthProfileListEnvelope = z.infer<
  typeof oauthProfileListEnvelopeSchema
>;

/**
 * Single-profile envelope. `profile` is validated structurally here and
 * canonicalized by the fetch layer — this schema only asserts it is an object,
 * because `canonicalizeOAuthProfile` is the authority on what a valid profile
 * is and duplicating its rules in Zod would create two sources of truth.
 */
export const oauthProfileEnvelopeSchema = z.object({
  schemaVersion: z.literal(SUPPORTED_OAUTH_PROFILE_SCHEMA_VERSION),
  catalogRevision: z.string().min(1),
  clientId: z.string().min(1),
  clientVersion: z.string().min(1).optional(),
  profileDigest: z.string().min(1),
  profile: z.record(z.string(), z.unknown()),
});

export type OAuthProfileEnvelope = Omit<
  z.infer<typeof oauthProfileEnvelopeSchema>,
  "profile"
> & { profile: HostConfigOAuthProfile };

/**
 * Content address of a profile: the sha256 of its canonical JSON.
 *
 * This is what binds a run to a profile and what the golden-trace comparator
 * checks a capture against, so it must be computed from the CANONICAL form —
 * two profiles that differ only in key order are the same profile and must
 * digest identically.
 */
export async function computeOAuthProfileDigest(
  profile: HostConfigOAuthProfile
): Promise<string> {
  return sha256Hex(JSON.stringify(canonicalizeOAuthProfile(profile)));
}
