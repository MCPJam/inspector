import { WorkOS } from "@workos-inc/node";

/**
 * Server-side WorkOS Node SDK client.
 *
 * Memoized as a per-process singleton. Reads `WORKOS_API_KEY` from the
 * environment on first call and throws if it is missing — the inspector
 * server should fail loud rather than silently fall back to unauthenticated
 * calls against WorkOS.
 *
 * This mirrors the backend factory pattern in
 * `mcpjam-backend/convex/lib/vault.ts` (`createWorkOSClient()`). Both
 * processes use the same `WORKOS_API_KEY` secret.
 *
 * Used today only by the WorkOS API Keys feature:
 *   - `server/middleware/bearer-auth.ts` — validate `sk_` bearers via
 *     `apiKeys.createValidation`.
 *   - `server/routes/web/api-keys.ts` — mint / list / revoke management
 *     endpoints (org-scoped operations only; user-scoped paths go through
 *     direct REST since the SDK doesn't expose them yet).
 */
let cachedClient: WorkOS | undefined;

export function getWorkOSClient(): WorkOS {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.WORKOS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "WORKOS_API_KEY is not set — required for WorkOS API key validation and management."
    );
  }
  cachedClient = new WorkOS(apiKey);
  return cachedClient;
}

/** Test-only: reset the memoized client (does not affect process env). */
export function resetWorkOSClientForTests(): void {
  cachedClient = undefined;
}
