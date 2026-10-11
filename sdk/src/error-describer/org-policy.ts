/**
 * Recognizing the refusals MCPJam sends when an organization requires its own
 * provider keys for AI features. Kept apart from `describe.ts` so the
 * policy's codes and their text patterns live in one small module.
 */

/**
 * The organization AI-key policy's refusal codes ("Use your keys for all AI
 * features"). Mirrors `AI_EXECUTION_REFUSAL_CODES` in the inspector's
 * `shared/ai-execution-refusal.ts`.
 */
const ORG_POLICY_REFUSAL_CODES = [
  "org_keys_required",
  "org_model_unconfigured",
  "org_runtime_unsupported",
  "ai_scope_unresolved",
  "ai_key_policy_unavailable",
  "provider_auth_failed",
  "provider_unavailable",
] as const;

export type OrgPolicyRefusalCode = (typeof ORG_POLICY_REFUSAL_CODES)[number];

const ORG_POLICY_REFUSAL_CODE_SET: ReadonlySet<string> = new Set(
  ORG_POLICY_REFUSAL_CODES,
);

function isOrgPolicyRefusalCode(code: string): code is OrgPolicyRefusalCode {
  return ORG_POLICY_REFUSAL_CODE_SET.has(code);
}

/** Each policy code's catalog slug. */
const ORG_POLICY_SLUG_BY_CODE: Readonly<
  Record<OrgPolicyRefusalCode, `org/${string}`>
> = {
  org_keys_required: "org/keys_required",
  org_model_unconfigured: "org/model_unconfigured",
  org_runtime_unsupported: "org/runtime_unsupported",
  ai_scope_unresolved: "org/scope_unresolved",
  ai_key_policy_unavailable: "org/key_policy_unavailable",
  provider_auth_failed: "org/provider_auth_failed",
  provider_unavailable: "org/provider_unavailable",
};

/**
 * The catalog slug for an organization AI-key policy refusal code, or
 * `undefined` when `code` is not one. Case-insensitive.
 */
export function orgPolicySlugForCode(
  code: string | null | undefined,
): string | undefined {
  if (typeof code !== "string") return undefined;
  const key = code.trim().toLowerCase();
  return isOrgPolicyRefusalCode(key) ? ORG_POLICY_SLUG_BY_CODE[key] : undefined;
}

/**
 * Codes distinctive enough to read out of free text: nothing but the policy
 * spells them.
 */
const DISTINCT_ORG_POLICY_CODE_IN_TEXT =
  /\b(org_keys_required|org_model_unconfigured|org_runtime_unsupported|ai_scope_unresolved|ai_key_policy_unavailable)\b/i;

/**
 * The two generic-sounding codes are read from text only where the text says
 * it is a code: a JSON `"code"` field, the engine's `(code` / `(code, HTTP n)`
 * suffix, or a `code:` lead. An MCP server's own prose saying "provider
 * unavailable" must not become the org's provider refusing.
 */
const GENERIC_ORG_POLICY_CODE_IN_TEXT =
  /"code"\s*:\s*"(provider_auth_failed|provider_unavailable)"|\((provider_auth_failed|provider_unavailable)\b|(?:^|[\s—-])(provider_auth_failed|provider_unavailable):/i;

/**
 * The policy refusal an error carries: a code field on the error (or its
 * `data` / `body`, or the `details` of a `PlatformApiError`, where the
 * platform API's envelope puts it), else a code named in its message.
 * `undefined` when it is not one.
 */
export function orgPolicyRefusal(
  error: unknown,
  message: string,
): { slug: string; rawCode: string } | undefined {
  if (error && typeof error === "object") {
    const record = error as {
      code?: unknown;
      data?: { code?: unknown };
      body?: { code?: unknown };
      details?: { code?: unknown };
      failureCode?: unknown;
    };
    for (const candidate of [
      record.data?.code,
      record.body?.code,
      record.details?.code,
      record.code,
      record.failureCode,
    ]) {
      if (typeof candidate !== "string") continue;
      const slug = orgPolicySlugForCode(candidate);
      if (slug) return { slug, rawCode: candidate.trim().toLowerCase() };
    }
  }
  const textMatch =
    DISTINCT_ORG_POLICY_CODE_IN_TEXT.exec(message) ??
    GENERIC_ORG_POLICY_CODE_IN_TEXT.exec(message);
  const code = textMatch?.slice(1).find((group) => group !== undefined);
  if (!code) return undefined;
  const slug = orgPolicySlugForCode(code);
  return slug ? { slug, rawCode: code.toLowerCase() } : undefined;
}
