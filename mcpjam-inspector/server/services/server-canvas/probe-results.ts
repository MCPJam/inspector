/**
 * Stores one probe run with the connecting user's bearer, through Convex
 * `serverProbeResults:recordProbeResults`. The backend checks the user's
 * project role, keys the row by context hash, and decides from the probe
 * statuses whether this attempt replaces the last good results.
 */
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference, type FunctionArgs } from "convex/server";
import type {
  CaptureContext,
  OAuthFlowSummary,
  ProbeSummary,
} from "@mcpjam/sdk";
import { getInspectorClientRuntimeConfig } from "../../env.js";

export const recordProbeResultsRef = makeFunctionReference<
  "mutation",
  {
    projectId: string;
    serverId: string;
    contextHash: string;
    captureContext: CaptureContext;
    probes: ProbeSummary[];
    oauthFlow?: OAuthFlowSummary;
    attemptError?: string;
  },
  { status: "inserted" | "updated" }
>("serverProbeResults:recordProbeResults");

export type ProbeResultsWrite = FunctionArgs<typeof recordProbeResultsRef>;

/**
 * The `attemptError` of a run after a failed capture. A fixed code, never the
 * error text, which can carry what the server sent.
 */
export const CAPTURE_FAILED_ATTEMPT = "capture_failed";

/**
 * Writes the run. Resolves with whether it was stored; throws only what the
 * mutation throws. No bearer or no Convex URL writes nothing.
 */
export async function writeProbeResults(
  convexBearer: string | undefined,
  args: ProbeResultsWrite,
): Promise<boolean> {
  const { convexUrl } = getInspectorClientRuntimeConfig();
  const bearer = convexBearer?.replace(/^Bearer\s+/i, "");
  if (!convexUrl || !bearer) return false;
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(bearer);
  await client.mutation(recordProbeResultsRef, args);
  return true;
}
