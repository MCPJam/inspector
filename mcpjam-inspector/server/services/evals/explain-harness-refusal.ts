/**
 * The text an eval launch refuses with when its harness admission fails.
 *
 * On a local Inspector, a harness that can't run on this machine falls back to
 * the cloud venue, and admission then refuses with "needs a cloud computer ...
 * Ask your MCPJam administrator", which nobody running the Inspector on their
 * own machine can act on. That one refusal is replaced here with the reason
 * the local venue wasn't chosen and its fix. Every other refusal, and every
 * refusal on the hosted app, keeps its own text.
 *
 * The reason is asked for again here, after the refusal, rather than carried
 * from the launch's venue check: launches keep their one check, and both ask
 * the same rules (`decideLocalHarnessVenue`).
 */
import { HOSTED_MODE } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { decideLocalHarnessVenue } from "../../utils/harness/local/run-resources.js";
import { describeLocalVenueRefusal } from "../../utils/harness/local/venue-refusal.js";
import { harnessNeedsProjectReason, type EvalHarnessAdmission } from "./harness-admission.js";

export async function explainEvalHarnessRefusal(args: {
  admission: Extract<EvalHarnessAdmission, { ok: false }>;
  bearer?: string;
  /** The suite's project; an organization-level suite has none. */
  projectId?: string | null;
}): Promise<string> {
  const { admission } = args;
  if (HOSTED_MODE || admission.kind !== "computers-unconfigured") return admission.reason;
  // A local harness run belongs to a project, exactly as a cloud box does.
  if (!args.projectId) return harnessNeedsProjectReason(admission.harness);
  try {
    const decision = await decideLocalHarnessVenue(admission.harness, args.bearer, args.projectId, { scope: "unattended" });
    const explained = await describeLocalVenueRefusal(decision, { bearer: args.bearer, projectId: args.projectId });
    return explained ?? admission.reason;
  } catch (error) {
    logger.warn("[evals] could not explain a harness refusal", {
      harness: admission.harness,
      message: error instanceof Error ? error.message : String(error),
    });
    return admission.reason;
  }
}
