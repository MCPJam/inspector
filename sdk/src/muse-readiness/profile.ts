/**
 * Muse's own vocabulary, as constants.
 *
 * Every list here is lifted from a numbered section of the connector
 * guidelines (`musePolicySource("docs", …)`), and the section is named next
 * to it so a drift in the policy page points straight at the constant it
 * moves.
 *
 * Pure data. Safe from the browser entry.
 */

/**
 * §3.2 "How tools are classified". Meta classifies every tool into exactly
 * one of these during review; a tool that both reads and writes is a write.
 *
 *   - `read` — retrieves information without changing data, account state or
 *     permissions.
 *   - `write` — creates, changes or deletes data, changes permissions, or acts
 *     on the user's behalf.
 *   - `sensitive-write` — irreversible or consequential (a purchase, an
 *     email). Muse asks for approval on EVERY use and offers no "Always
 *     allow" (§3.3).
 */
export const MUSE_TOOL_CLASSES = ["read", "write", "sensitive-write"] as const;

export type MuseToolClass = (typeof MUSE_TOOL_CLASSES)[number];

/**
 * §5.4: "In your API or MCP documentation, include setup instructions, inputs
 * and outputs, read/write classifications, sensitive designations,
 * permissions, side effects, status handling, errors, and rate limits."
 * One entry per item, so a profile missing one names WHICH.
 */
export const MUSE_DOCUMENTATION_TOPICS = [
  "setup-instructions",
  "inputs-and-outputs",
  "read-write-classifications",
  "sensitive-designations",
  "permissions",
  "side-effects",
  "status-handling",
  "errors",
  "rate-limits",
] as const;

export type MuseDocumentationTopic = (typeof MUSE_DOCUMENTATION_TOPICS)[number];

/** §5.4: "such as OAuth client credentials or an API key". */
export const MUSE_AUTH_METHODS = ["oauth", "api-key", "none", "other"] as const;

export type MuseAuthMethod = (typeof MUSE_AUTH_METHODS)[number];

/** §5.4: "Identify whether these apply to a test or production environment." */
export const MUSE_CREDENTIAL_ENVIRONMENTS = ["test", "production"] as const;

export type MuseCredentialEnvironment =
  (typeof MUSE_CREDENTIAL_ENVIRONMENTS)[number];

/**
 * The submission steps that are a claim about the world no probe can verify.
 *
 *   - `businessVerificationProvided` — §5.2 business information and evidence.
 *   - `brandAssetsAuthorized` — §5.2 "authorized brand assets".
 *   - `maintainerNamed` — §5.2 "a developer responsible for maintenance".
 *   - `dataProcessingQuestionnaireCompleted` — §5.3, matching the privacy policy.
 *   - `acceptsDeveloperTerms` — §4.1 and §5.2.
 *
 * Presence is checked; truth stays with Meta's reviewers.
 */
export const MUSE_ATTESTATIONS = [
  "businessVerificationProvided",
  "brandAssetsAuthorized",
  "maintainerNamed",
  "dataProcessingQuestionnaireCompleted",
  "acceptsDeveloperTerms",
] as const;

export type MuseAttestation = (typeof MUSE_ATTESTATIONS)[number];
