/**
 * The server's shared "this needs the hosted app" answer.
 *
 * A self-hosted Inspector (npx, Docker, desktop) holds no MCPJam service
 * credential, so a few features can only run at app.mcpjam.com. Every such
 * refusal has one shape — `code: "FEATURE_NOT_SUPPORTED"` with
 * `details.reason: "FEATURE_REQUIRES_HOSTED"` (see `hostedOnlyRouteError` in
 * `server/routes/web/errors.ts`) — so the client can say so with one piece of
 * copy instead of a generic failure.
 */
export const FEATURE_REQUIRES_HOSTED = "FEATURE_REQUIRES_HOSTED";

export const DEFAULT_HOSTED_APP_URL = "https://app.mcpjam.com";

export interface HostedOnlyDetails {
  reason: typeof FEATURE_REQUIRES_HOSTED;
  feature?: string;
  hostedUrl?: string;
}

/** True for a parsed error body carrying the hosted-only answer. */
export function isHostedOnlyErrorBody(body: unknown): body is {
  code: "FEATURE_NOT_SUPPORTED";
  message?: string;
  details: HostedOnlyDetails;
} {
  if (!body || typeof body !== "object") return false;
  const record = body as { code?: unknown; details?: unknown };
  if (record.code !== "FEATURE_NOT_SUPPORTED") return false;
  const details = record.details as { reason?: unknown } | undefined;
  return details?.reason === FEATURE_REQUIRES_HOSTED;
}

/** User-facing sentence for a hosted-only refusal. */
export function hostedOnlyMessage(
  details?: Partial<HostedOnlyDetails>,
): string {
  const feature = details?.feature?.trim() || "This feature";
  const url = details?.hostedUrl?.trim() || DEFAULT_HOSTED_APP_URL;
  return `${feature} is available in the hosted MCPJam app (${url}).`;
}
