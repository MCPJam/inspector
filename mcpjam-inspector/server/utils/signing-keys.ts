/**
 * Key rings for the server's own HMAC signatures (tool approvals, chat history
 * provenance), each rooted in a DEDICATED secret with an accept-list.
 *
 * WHY NOT THE SERVICE CREDENTIAL. These keys used to be derived only from
 * `INSPECTOR_SERVICE_TOKEN`, the credential that also gates every
 * `/internal/v1/*` call. Rotating that token therefore silently invalidated
 * every outstanding approval and every signature on stored chat history — and
 * an unverifiable history is shown to the model with all prior assistant
 * content left out. Rotating infrastructure access should not wipe what the
 * model remembers.
 *
 * THE RING, per purpose:
 *
 *   `<NAME>`           current secret — signs, and verifies;
 *   `<NAME>_PREVIOUS`  the one before it — verifies only, so a rotation is a
 *                      non-event: set PREVIOUS to the old value, CURRENT to the
 *                      new one, and drop PREVIOUS once nothing signed under it
 *                      is still in use;
 *   service credential the LEGACY root, verify-only once `<NAME>` is set (and
 *                      still the signer while it is not). Accepted alongside
 *                      `<NAME>` so signatures made before the switch keep
 *                      verifying — until `MCPJAM_ACCEPT_LEGACY_SIGNING_KEY=
 *                      false`, which drops it, so the infrastructure token can
 *                      no longer forge an approval or a history signature.
 *
 * Every secret is turned into a key the same way the legacy one always was —
 * `HMAC-SHA256(secret, label)` — so setting `<NAME>_PREVIOUS` to the old
 * service-token value reproduces the legacy key exactly. Nothing is re-signed
 * when a secret is set, and the legacy key follows the CURRENT token, so that
 * is the way to keep pre-switch history verifiable across a token rotation or
 * the removal of the legacy fallback, whichever comes first.
 *
 * Values shorter than `MIN_SERVICE_TOKEN_LENGTH` are ignored: a key derived
 * from a guessable secret is worse than none.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  getServiceCredential,
  MIN_SERVICE_TOKEN_LENGTH,
} from "../services/service-credential.js";

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface SigningKeyRing {
  /** The key new signatures are made with. */
  signing: Buffer;
  /** Every key a signature may verify under, the signing key first. */
  accepted: readonly Buffer[];
}

export const TOOL_APPROVAL_SIGNING_SECRET_ENV = "TOOL_APPROVAL_SIGNING_SECRET";
export const HISTORY_PROVENANCE_SECRET_ENV = "HISTORY_PROVENANCE_SECRET";
export const SIGNING_SECRET_ENVS = [
  TOOL_APPROVAL_SIGNING_SECRET_ENV,
  HISTORY_PROVENANCE_SECRET_ENV,
] as const;

/**
 * Set to `false` to stop accepting the legacy service-token-derived key once a
 * dedicated secret is set. Default on for the migration release: turning it
 * off without first setting `<NAME>_PREVIOUS` to the old token value makes
 * history signed before the switch unverifiable.
 */
export const ACCEPT_LEGACY_SIGNING_KEY_ENV = "MCPJAM_ACCEPT_LEGACY_SIGNING_KEY";

function acceptsLegacyKey(env: Env): boolean {
  return env[ACCEPT_LEGACY_SIGNING_KEY_ENV]?.trim().toLowerCase() !== "false";
}

/** `HMAC-SHA256(secret, label)`, or null for a missing or too-short secret. */
export function deriveLabeledKey(
  secret: string | null | undefined,
  label: string,
): Buffer | null {
  const value = secret?.trim();
  if (!value || value.length < MIN_SERVICE_TOKEN_LENGTH) return null;
  return createHmac("sha256", value).update(label).digest();
}

function sameKey(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The ring for one purpose, or null when nothing can sign: no dedicated secret
 * and no (long enough) service credential.
 */
export function resolveSigningKeyRing(args: {
  /** Base env var name; `<name>_PREVIOUS` is the verify-only predecessor. */
  secretEnv: string;
  label: string;
  env?: Env;
}): SigningKeyRing | null {
  const env = args.env ?? process.env;
  const current = deriveLabeledKey(env[args.secretEnv], args.label);
  const previous = deriveLabeledKey(
    env[`${args.secretEnv}_PREVIOUS`],
    args.label,
  );
  const legacy = deriveLabeledKey(getServiceCredential(env), args.label);
  const signing = current ?? legacy;
  if (!signing) return null;
  // While no dedicated secret is set the legacy key IS the signer; the switch
  // only removes it as an extra accepted key next to a dedicated secret.
  const acceptedLegacy = current && !acceptsLegacyKey(env) ? null : legacy;
  const accepted: Buffer[] = [];
  for (const key of [signing, previous, acceptedLegacy]) {
    if (key && !accepted.some((seen) => sameKey(seen, key))) accepted.push(key);
  }
  return { signing, accepted };
}

/**
 * The dedicated secrets that are set while the legacy service-token key is
 * still accepted next to them — what the boot log warns about until
 * `MCPJAM_ACCEPT_LEGACY_SIGNING_KEY=false`. Names only.
 */
export function signingSecretsStillAcceptingLegacy(
  env: Env = process.env,
): string[] {
  if (!acceptsLegacyKey(env)) return [];
  if (!deriveLabeledKey(getServiceCredential(env), "probe")) return [];
  return SIGNING_SECRET_ENVS.filter(
    (name) => deriveLabeledKey(env[name], "probe") !== null,
  );
}
