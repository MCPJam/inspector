import { z } from "zod";

/**
 * Zod schema for the "OAuth conformance profile" input shape that hosts pass
 * from their UI/API layer into the runner. Mirrors the tunable subset of
 * {@link OAuthConformanceConfig} so callers don't have to reinvent it for
 * each route.
 *
 * All fields are optional — hosts can layer this on top of a resolved
 * `serverUrl` and fill in only what the user overrode.
 */
export const oauthConformanceProfileSchema = z.object({
  serverUrl: z.string().optional(),
  protocolVersion: z
    .enum(["2025-03-26", "2025-06-18", "2025-11-25"])
    .optional(),
  registrationStrategy: z.enum(["cimd", "dcr", "preregistered"]).optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  scopes: z.string().optional(),
  customHeaders: z
    .array(z.object({ key: z.string(), value: z.string() }))
    .optional(),
});

export type OAuthConformanceProfile = z.infer<
  typeof oauthConformanceProfileSchema
>;

/**
 * Flatten the `customHeaders: [{ key, value }]` array form that UIs use into
 * the `Record<string, string>` form the runner expects. Empty keys are
 * dropped so partially-filled UI rows don't create `""` headers.
 */
export function normalizeCustomHeaders(
  input: OAuthConformanceProfile["customHeaders"] | undefined,
): Record<string, string> | undefined {
  if (!input || input.length === 0) return undefined;
  const headers: Record<string, string> = {};
  for (const { key, value } of input) {
    if (key) headers[key] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}
