/**
 * The non-secret OAuth-flow summary a client sends with the first connect
 * after a successful OAuth flow (`OAuthFlowSummary` in `@mcpjam/sdk`).
 *
 * Validated field by field and bounded. Unknown keys are dropped by the
 * schema, so a client that sent a token, code, verifier or secret by mistake
 * could not get it past this point. An invalid summary reads as absent: it
 * never fails the connect it rides on.
 *
 * The bounds are the backend's (`checkOAuthFlow` in
 * `convex/lib/serverProbeResults.ts`), so a summary that passes here is never
 * the reason a probe write is refused.
 */
import { z } from "zod";
import type { OAuthFlowSummary } from "@mcpjam/sdk";

const MAX_SCOPES = 64;
const MAX_SCOPE_CHARS = 200;
const MAX_ISSUER_CHARS = 512;
/** RFC 6749 scope-token characters. */
const SCOPE_PATTERN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
/** A protocol version or token endpoint auth method. */
const TOKEN_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const ScopeSchema = z.string().max(MAX_SCOPE_CHARS).regex(SCOPE_PATTERN);

/** An http(s) URL without credentials, query or fragment. */
function isIssuerUrl(issuer: string): boolean {
  try {
    const url = new URL(issuer);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    // Not a URL: refused like any other malformed issuer.
    return false;
  }
}

export const oauthFlowSummarySchema = z.object({
  completedAt: z.number().int().nonnegative(),
  issuer: z.string().max(MAX_ISSUER_CHARS).refine(isIssuerUrl).optional(),
  protocolVersion: z.string().regex(TOKEN_PATTERN).optional(),
  registrationStrategy: z.enum(["preregistered", "dcr", "cimd"]).optional(),
  resourceIndicatorSent: z.boolean(),
  scopesRequested: z.array(ScopeSchema).max(MAX_SCOPES),
  scopesGranted: z.array(ScopeSchema).max(MAX_SCOPES),
  issReturned: z.boolean(),
  issValidated: z.boolean(),
  refreshTokenIssued: z.boolean(),
  tokenEndpointAuthMethod: z.string().regex(TOKEN_PATTERN).optional(),
}) satisfies z.ZodType<OAuthFlowSummary>;

/**
 * For a request schema: an optional summary that reads as absent when it
 * does not validate, so a bad summary never fails the connect.
 */
export const optionalOAuthFlowSummarySchema = oauthFlowSummarySchema
  .optional()
  .catch(undefined);

/** The summary in an untyped body field, or `undefined`. */
export function parseOAuthFlowSummary(
  value: unknown,
): OAuthFlowSummary | undefined {
  const parsed = oauthFlowSummarySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
