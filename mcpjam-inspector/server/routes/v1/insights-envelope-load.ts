/**
 * Loading the insights envelope as an ENRICHMENT on a detail response.
 *
 * All three detail routes want the same thing: attach the envelope when the
 * caller may have it, and never let its absence fail the resource. What
 * differs from an ordinary catch-site is which failures deserve attention.
 *
 * A REFUSAL here is routine. The envelope is gated more tightly than the
 * resource around it (workspace membership vs. visibility), so an ordinary
 * lower-privilege viewer — a share-link guest polling their own page — will
 * be refused on every request. Reporting those would bury a genuine breakage
 * under expected noise and, through `reportRouteFailure`, risk paging for it.
 *
 * A genuine failure is the opposite: a renamed function, schema drift against
 * the hand-mirrored contract, an outage. Those are invisible if the field
 * simply goes missing, since absence is also how an older backend behaves.
 *
 * So refusals are silent and everything else is reported through the
 * centralized path, using the same classifier the read-error translator uses
 * to tell the two apart.
 */
import { classifyConvexReadError } from "./convex-read-errors.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";

export type InsightsEnvelopeSource =
  | "v1.evals"
  | "v1.journeys"
  | "v1.user-testing";

/**
 * Run an envelope read, returning `undefined` instead of throwing.
 *
 * @param source route slug, for the failure report's `source`
 * @param read the Convex query call
 */
export async function loadInsightsEnvelope(
  source: InsightsEnvelopeSource,
  read: () => Promise<unknown>,
): Promise<Record<string, unknown> | undefined> {
  try {
    const envelope = await read();
    return envelope ? (envelope as Record<string, unknown>) : undefined;
  } catch (error) {
    const failure = classifyConvexReadError(error);
    const expected =
      failure.kind === "membership" ||
      failure.kind === "authentication" ||
      // Production redacts a plain-error refusal to "Server Error". On THIS
      // read that shape is overwhelmingly a refusal rather than a crash, and
      // the cost of staying quiet is one missed log on a request whose
      // resource still returned.
      failure.kind === "redacted";
    if (!expected) {
      reportRouteFailure(`[${source}] insights envelope unavailable`, error, {
        source: `${source}.insights-envelope`,
        hop: "mcpjam_internal",
      });
    }
    return undefined;
  }
}
