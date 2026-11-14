import { makeFunctionReference } from "convex/server";
import { createConvexClient } from "../../services/evals/route-helpers.js";
import { logger } from "../logger.js";

// The backend's query, by name: this package does not import the backend's
// generated API. Mirrors `convex/hostedBrowser.ts` in mcpjam-backend.
const GET_HOSTED_BROWSER_AVAILABILITY = makeFunctionReference<"query">(
  "hostedBrowser:getAvailability",
);

export type HostedBrowserSurface = "inspector" | "tools";

interface SurfaceAvailability {
  available: boolean;
  reason: string | null;
}

type ConvexQueryClient = {
  query: (
    query: typeof GET_HOSTED_BROWSER_AVAILABILITY,
    args: { projectId: string },
  ) => Promise<unknown>;
};

function surfaceAnswer(
  value: unknown,
  surface: HostedBrowserSurface,
): SurfaceAvailability | null {
  if (!value || typeof value !== "object") return null;
  const answer = (value as Record<string, unknown>)[surface];
  if (!answer || typeof answer !== "object") return null;
  const { available, reason } = answer as Record<string, unknown>;
  if (typeof available !== "boolean") return null;
  return { available, reason: typeof reason === "string" ? reason : null };
}

/**
 * May this member use the hosted browser in this project, on this surface?
 *
 * Asked of the backend with the member's own bearer, so the `hosted-browser`
 * flag is evaluated by their email exactly as every launch path evaluates it.
 * This server cannot do that itself: it knows a WorkOS id, not an email, and
 * the rollout targets email.
 *
 * Never rejects. No bearer, no Convex URL, an older backend without the query
 * or any other failure reads as "not available": offering a browser the
 * backend would refuse costs a confusing failure later in the run.
 */
export async function isHostedBrowserAvailableFor(args: {
  bearer: string | null | undefined;
  projectId: string | null | undefined;
  surface: HostedBrowserSurface;
  client?: ConvexQueryClient;
}): Promise<boolean> {
  const bearer = args.bearer?.replace(/^Bearer\s+/i, "").trim();
  if (!bearer || !args.projectId) return false;
  try {
    const client = args.client ?? createConvexClient(bearer);
    const answer = surfaceAnswer(
      await client.query(GET_HOSTED_BROWSER_AVAILABILITY, {
        projectId: args.projectId,
      }),
      args.surface,
    );
    return answer?.available === true;
  } catch (error) {
    logger.warn(
      "[computers] hosted-browser availability check failed; treating it as unavailable",
      { error: error instanceof Error ? error.message : String(error) },
    );
    return false;
  }
}
