/**
 * How the inspector server reads a backend refusal from the organization AI
 * key policy ("Use your keys for all AI features"): which catalog slug it
 * maps to, and which codes are expected denials rather than MCPJam faults.
 */
import { orgPolicySlugForCode } from "@mcpjam/sdk";
import type { AiRefusalCode } from "@/shared/ai-execution-refusal";

/** The backend route an org-key-policy refusal arrived on. */
const ORG_STREAM_PATH = "/stream/org";

/**
 * Where a stream failure came from, for the codes whose meaning depends on the
 * route: `credential_missing` is the org connection's refusal only on
 * `/stream/org`.
 */
export type BackendStreamFailureContext = {
  /** The backend path the request was sent to (`/stream`, `/stream/org`). */
  endpointPath?: string;
};

/**
 * The catalog slug for an organization AI-key policy refusal ("Use your keys
 * for all AI features"), or `undefined` when `code` is not one.
 *
 * Each policy code has its own `org/*` slug, whose catalog origin is the
 * policy's verdict: a configuration refusal is `user_config` (the
 * organization's own settings — never an outage, never an account limit, never
 * paged), `provider_unavailable` is `ambiguous`, and only
 * `ai_key_policy_unavailable` — the backend failing closed on its own policy
 * read — is `mcpjam`. Read by status alone they would be badly wrong: a 403
 * `org_keys_required` would become "the provider rejected the key", and a 503
 * `provider_unavailable` an MCPJam outage.
 *
 * `credential_missing` is the org connection's refusal (deleted, disabled, no
 * key) only when it arrives on `/stream/org`; elsewhere the code is left to
 * the ordinary rules.
 */
export function orgPolicyRefusalSlug(
  code: string | undefined,
  context: BackendStreamFailureContext | undefined,
): string | undefined {
  const slug = orgPolicySlugForCode(code);
  if (slug) return slug;
  if (code === "credential_missing" && context?.endpointPath === ORG_STREAM_PATH)
    return "org/credential_missing";
  return undefined;
}

/**
 * The organization AI-key policy's refusals that are the backend working as
 * designed: the organization's own configuration said no (it requires its own
 * keys, has no default model set, its connection is gone or its key was
 * rejected) or its own provider is throttling. Recognized as expected
 * refusals at EVERY status — they arrive as 403, 422 and 503, not only as the
 * 200 spend-precheck shape — so none of them is captured as an MCPJam fault.
 *
 * Kept OUT of `USER_OWNED_DENIAL_CODES` (`mcpjam-stream-handler.ts`) on purpose: that set mirrors the
 * account-limit vocabulary (`isAccountLimit`, pinned by a parity test), and an
 * organization that requires its own keys has not hit an account limit —
 * buying credits lifts none of these, and a whole-run "account limit" stop
 * would give the wrong advice.
 *
 * `ai_key_policy_unavailable` is deliberately ABSENT: it is the backend
 * failing closed on its own policy read, which is ours and should be counted.
 */
const AI_POLICY_RECOGNIZED_DENIAL_CODES: ReadonlySet<string> = new Set([
  "org_keys_required",
  "org_model_unconfigured",
  "org_runtime_unsupported",
  "ai_scope_unresolved",
  "provider_auth_failed",
  "provider_unavailable",
  "credential_missing",
] satisfies readonly AiRefusalCode[]);

/** See {@link AI_POLICY_RECOGNIZED_DENIAL_CODES}. */
export function isAiPolicyRecognizedDenialCode(
  code: string | undefined,
): boolean {
  return AI_POLICY_RECOGNIZED_DENIAL_CODES.has(code ?? "");
}
