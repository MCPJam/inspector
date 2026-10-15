/**
 * Recognizing the refusals MCPJam sends when an organization requires its own
 * provider keys for AI features. Kept apart from `describe.ts` so the
 * policy's text patterns live in one small module. The codes themselves come
 * from `../ai-refusal-codes.ts`.
 */

import {
  AI_EXECUTION_REFUSAL_CODES,
  isAiExecutionRefusalCode,
  type AiExecutionRefusalCode,
} from "../ai-refusal-codes.js";

/** Each policy code's catalog slug. */
const ORG_POLICY_SLUG_BY_CODE: Readonly<
  Record<AiExecutionRefusalCode, `org/${string}`>
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
  code: string | null | undefined
): string | undefined {
  if (typeof code !== "string") return undefined;
  const key = code.trim().toLowerCase();
  return isAiExecutionRefusalCode(key)
    ? ORG_POLICY_SLUG_BY_CODE[key]
    : undefined;
}

/**
 * The two generic-sounding codes. They are read from text only where the text
 * says it is a code: a JSON `"code"` field, the engine's `(code` /
 * `(code, HTTP n)` suffix, or a `code:` lead. An MCP server's own prose saying
 * "provider unavailable" must not become the org's provider refusing.
 */
const GENERIC_ORG_POLICY_CODES = [
  "provider_auth_failed",
  "provider_unavailable",
] as const satisfies readonly AiExecutionRefusalCode[];

const GENERIC_ORG_POLICY_CODE_SET: ReadonlySet<string> = new Set(
  GENERIC_ORG_POLICY_CODES
);

/**
 * Every other policy code is distinctive enough to read out of free text:
 * nothing but the policy spells them.
 */
const DISTINCT_ORG_POLICY_CODES = AI_EXECUTION_REFUSAL_CODES.filter(
  (code) => !GENERIC_ORG_POLICY_CODE_SET.has(code)
);

const DISTINCT_ORG_POLICY_CODE_IN_TEXT = new RegExp(
  `\\b(${DISTINCT_ORG_POLICY_CODES.join("|")})\\b`,
  "i"
);

const GENERIC = GENERIC_ORG_POLICY_CODES.join("|");

const GENERIC_ORG_POLICY_CODE_IN_TEXT = new RegExp(
  `"code"\\s*:\\s*"(${GENERIC})"|\\((${GENERIC})\\b|(?:^|[\\s—-])(${GENERIC}):`,
  "i"
);

/**
 * The policy refusal an error carries: a code field on the error (or its
 * `data` / `body`, or the `details` of a `PlatformApiError`, where the
 * platform API's envelope puts it), else a code named in its message.
 * `undefined` when it is not one.
 *
 * The code fields are read through the `cause` chain, as `describe.ts` reads
 * an HTTP status: a wrapper that keeps the refusal on its cause would
 * otherwise be classified by that cause's 403.
 */
export function orgPolicyRefusal(
  error: unknown,
  message: string
): { slug: string; rawCode: string } | undefined {
  const seen = new Set<unknown>();
  let current = error;
  for (
    let depth = 0;
    depth < 5 && current && typeof current === "object" && !seen.has(current);
    depth++
  ) {
    seen.add(current);
    const record = current as {
      code?: unknown;
      data?: { code?: unknown };
      body?: { code?: unknown };
      details?: { code?: unknown };
      failureCode?: unknown;
      cause?: unknown;
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
    current = record.cause;
  }
  const textMatch =
    DISTINCT_ORG_POLICY_CODE_IN_TEXT.exec(message) ??
    GENERIC_ORG_POLICY_CODE_IN_TEXT.exec(message);
  const code = textMatch?.slice(1).find((group) => group !== undefined);
  if (!code) return undefined;
  const slug = orgPolicySlugForCode(code);
  return slug ? { slug, rawCode: code.toLowerCase() } : undefined;
}
