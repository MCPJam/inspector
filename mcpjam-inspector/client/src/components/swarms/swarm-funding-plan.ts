/**
 * How the New swarm flow talks about, previews and verifies the sponsored
 * split of a launch.
 *
 * Sponsored conversations are paid from MCPJam's per-user allowance; the rest
 * use the organization's credits. The backend decides the split when a run is
 * created. Everything here exists so the person launching sees the split BEFORE
 * anything runs, and so a launch can never quietly use more org credits than
 * they were shown.
 */
import type {
  SwarmFundingPreview,
  SwarmFundingPreviewRunInput,
} from "@/lib/swarm-api";
import type { LaunchTarget } from "@/components/swarms/new-swarm-confirm-step";
import { sameEnvironmentSelection } from "@/components/swarms/reused-environment-move";

/**
 * The per-run overrides a launch sends, in one place so the preview asks about
 * EXACTLY the runs the launch will create.
 *
 * A just-created goal is born with the selection and iterations (`environmentIds`
 * is undefined on its target), so it sends none. A reused goal sends the
 * Describe selection when its stored fan-out differs from it, and the
 * iterations chosen on Confirm.
 */
export function launchRunOverrides(
  target: LaunchTarget,
  environmentIds: string[] | null,
): { environmentIds?: string[]; sessionsPerTarget?: number } {
  return {
    ...(environmentIds &&
    target.environmentIds !== undefined &&
    !sameEnvironmentSelection(target.environmentIds, environmentIds)
      ? { environmentIds }
      : {}),
    ...(target.sessionsPerTarget != null
      ? { sessionsPerTarget: target.sessionsPerTarget }
      : {}),
  };
}

/** The preview request for a launch's targets, in launch order. */
export function fundingPreviewRuns(
  targets: readonly LaunchTarget[],
  environmentIds: string[] | null,
): SwarmFundingPreviewRunInput[] {
  return targets.map((target) => ({
    journeyRefId: target.journeyId,
    ...launchRunOverrides(target, environmentIds),
  }));
}

export interface FundingSplit {
  sponsored: number;
  credits: number;
  total: number;
}

/**
 * The split of a supported preview, or `null` when there is nothing to show:
 * sponsorship does not apply here, or the preview does not cover the runs asked
 * about (an older backend answering fewer runs must not read as a full split).
 */
export function fundingSplitOf(
  preview: SwarmFundingPreview,
  requestedRuns: number,
): FundingSplit | null {
  if (!preview.supported || preview.runs.length !== requestedRuns) return null;
  return preview.runs.reduce<FundingSplit>(
    (sum, run) => ({
      sponsored: sum.sponsored + run.sponsored,
      credits: sum.credits + run.credits,
      total: sum.total + run.total,
    }),
    { sponsored: 0, credits: 0, total: 0 },
  );
}

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

/** "5 sponsored conversations · 10 use org credits". */
export function fundingHeadline(split: FundingSplit): string {
  return `${plural(
    split.sponsored,
    "sponsored conversation",
    "sponsored conversations",
  )} · ${split.credits.toLocaleString()} ${
    split.credits === 1 ? "uses" : "use"
  } org credits`;
}

/**
 * Why some conversations use org credits, when some do. Says what the preview
 * knows and nothing more: targets the backend marked ineligible, and an
 * allowance that ran short. It never promises sponsored capacity will hold.
 */
export function creditFundingExplanation(
  preview: SwarmFundingPreview,
  split: FundingSplit,
): string | null {
  if (split.credits === 0) return null;
  const ineligible = new Set<string>();
  for (const run of preview.runs) {
    for (const target of run.targets) {
      if (!target.eligible) ineligible.add(target.targetId);
    }
  }
  const parts: string[] = [];
  if (ineligible.size > 0) {
    parts.push(
      ineligible.size === 1
        ? "One target can't use sponsored conversations (they cover MCPJam-hosted models in emulated environments), so its conversations use org credits."
        : `${ineligible.size} targets can't use sponsored conversations (they cover MCPJam-hosted models in emulated environments), so their conversations use org credits.`,
    );
  }
  if (preview.remaining <= split.sponsored) {
    parts.push(
      preview.remaining === 0
        ? "Your sponsored allowance is used up, so the rest use org credits."
        : `Your sponsored allowance covers ${plural(
            preview.remaining,
            "more conversation",
            "more conversations",
          )}; the rest use org credits.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * The sentence shown when a launch stops before creating any run because the
 * split is not the one the person was looking at. Nothing was launched, and
 * nothing will be until they launch again with the split now on screen.
 */
export function fundingReviewNotice(args: {
  shown: number | null;
  now: FundingSplit;
}): string {
  const now = fundingHeadline(args.now);
  return args.shown === null
    ? `This launch can use sponsored conversations: ${now}. Nothing was launched. Review the split, then launch again.`
    : `Sponsored conversations changed while you were reviewing this launch. It was ${plural(
        args.shown,
        "sponsored conversation",
        "sponsored conversations",
      )}; now it is ${now}. Nothing was launched. Review the split, then launch again.`;
}

/**
 * The final split check could not be made after a split was on screen. Launching
 * without it could move conversations onto the organization's credits, so
 * nothing is launched.
 */
export function fundingUnverifiedNotice(shown: number): string {
  return `We couldn't confirm the ${plural(
    shown,
    "sponsored conversation",
    "sponsored conversations",
  )} you were shown, so nothing was launched. Try launching again.`;
}

/** The 409 case: the backend refused a run whose split had moved. */
export function fundingChangedNotice(args: {
  launched: number;
  total: number;
  actualSponsored: number;
  totalConversations: number;
}): string {
  const now = `${plural(
    args.actualSponsored,
    "sponsored conversation",
    "sponsored conversations",
  )} of ${args.totalConversations.toLocaleString()}`;
  return args.launched === 0
    ? `Sponsored conversations changed before this launch started: now ${now}. Nothing was launched and nothing was moved to org credits. Review the split, then launch again.`
    : `Launched ${args.launched} of ${args.total} runs. Sponsored conversations changed for the next run (now ${now}), so the remaining runs were not started and none were moved to org credits. Launch them again from Goals to see the updated split.`;
}
