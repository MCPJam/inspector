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

/**
 * Targets a previous attempt persisted, with the iterations chosen NOW.
 *
 * The goals are real once the first launch attempt created them, and Confirm
 * stays editable. A persisted target keeps what it carries unless the person has
 * since moved that persona's counter, in which case the new count rides the
 * preview and the launch as the per-run override, the way a reused goal's does.
 * A counter that still reads what a just-created goal was born with sends
 * nothing, so an untouched swarm launches exactly as it did before.
 */
export function withChosenIterations(
  targets: readonly LaunchTarget[],
  chosen: Readonly<Record<string, number>>,
): LaunchTarget[] {
  return targets.map((target) => {
    const edited =
      target.iterationsKey !== undefined
        ? chosen[target.iterationsKey]
        : undefined;
    if (edited === undefined) return target;
    const current = target.sessionsPerTarget ?? target.bornIterations;
    return edited === current
      ? target
      : { ...target, sessionsPerTarget: edited };
  });
}

/**
 * The preview request for a launch's targets, in launch order.
 *
 * Every run is asked about as the swarm the launch makes it: the launch sends
 * `kind: "swarm"` for each run it creates. Left out, the backend resolves the
 * kind from the session count, so a goal with one conversation and no swarm of
 * its own previews as user testing (never sponsored), then launches as a swarm
 * (sponsored) and is refused for the split it was shown, on every attempt.
 */
export function fundingPreviewRuns(
  targets: readonly LaunchTarget[],
  environmentIds: string[] | null,
): SwarmFundingPreviewRunInput[] {
  return targets.map((target) => ({
    journeyRefId: target.journeyId,
    kind: "swarm",
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
 * The cause the backend named for an ineligible target, as the clause that goes
 * after "can't use sponsored conversations". Each says its own cause and
 * nothing broader: a target held back by the price gate IS an MCPJam-hosted
 * model in an emulated environment, so a blanket "they cover hosted models in
 * emulated environments" contradicts it. `null` for a reason this build has no
 * wording for, which leaves the sentence without a parenthetical rather than
 * guessing.
 */
function ineligibilityClause(
  reason: string | undefined,
  count: number,
): string | null {
  const one = count === 1;
  switch (reason) {
    case "model_not_included":
      return one
        ? "its model isn't included in them"
        : "their models aren't included in them";
    // Stamped on every target when the PERSONA driver is on an organization or
    // local connection, as well as on a target whose own model is. So it names
    // the model, not whose it is.
    case "byok_model":
      return one
        ? "a model it uses is set to your own connection"
        : "a model they use is set to your own connection";
    case "harness_target":
      return one
        ? "it runs a coding-agent harness"
        : "they run a coding-agent harness";
    case "computer_target":
      return one
        ? "it uses a computer or shell"
        : "they use a computer or shell";
    case "unresolved":
      return one
        ? "its setup could not be read"
        : "their setup could not be read";
    // Run-wide causes: every target of the run carries the same one.
    case "persona_model_not_included":
      return "the persona model isn't included in them";
    case "grounding_model_not_included":
      return "the grounding model isn't included in them";
    // The backend names the saved selection, not where the judge would run.
    case "judge_selection_not_hosted":
      return "the judge is set to a model MCPJam doesn't host";
    case "judge_model_not_included":
      return "the judge model isn't included in them";
    default:
      return null;
  }
}

/**
 * Why some conversations use org credits, when some do. Says what the preview
 * knows and nothing more: targets the backend marked ineligible, with the cause
 * it named for each, and an allowance that ran short. It never promises
 * sponsored capacity will hold.
 */
export function creditFundingExplanation(
  preview: SwarmFundingPreview,
  split: FundingSplit,
): string | null {
  if (split.credits === 0) return null;
  // One entry per target however many runs carry it, with the first cause named.
  const reasonByTarget = new Map<string, string | undefined>();
  for (const run of preview.runs) {
    for (const target of run.targets) {
      if (!target.eligible && !reasonByTarget.has(target.targetId)) {
        reasonByTarget.set(target.targetId, target.reason);
      }
    }
  }
  const targetsByReason = new Map<string | undefined, number>();
  for (const reason of reasonByTarget.values()) {
    targetsByReason.set(reason, (targetsByReason.get(reason) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [reason, count] of targetsByReason) {
    const clause = ineligibilityClause(reason, count);
    parts.push(
      `${count === 1 ? "One target" : `${count} targets`} can't use sponsored conversations${
        clause ? ` (${clause})` : ""
      }, so ${count === 1 ? "its" : "their"} conversations use org credits.`,
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

/**
 * A failure recorded earlier in the same launch pass, to say beside a funding
 * stop. The stops return before the launch's own summary, so without this a goal
 * that could not be created, or a run that failed before the split moved, was
 * never shown (and a deterministic failure behind a 409 looped on "review the
 * split" forever).
 */
export function alsoFailedNotice(failure: string): string {
  const sentence = failure.trim();
  return `Also, part of this launch failed: ${
    /[.!?]$/.test(sentence) ? sentence : `${sentence}.`
  }`;
}

/**
 * What a launch that did not fully go through says beside the runs that did
 * launch, so the explanation outlives the toast that announces it. "Launched 1
 * of 3 runs. Part of this launch failed: Network down." A launch that started
 * everything it created but was missing a goal says it the same way.
 */
export function launchOutcomeNotice({
  launched,
  total,
  failure,
}: {
  launched: number;
  total: number;
  failure: string;
}): string {
  const sentence = failure.trim();
  const count =
    launched === total
      ? `Launched ${launched} ${launched === 1 ? "run" : "runs"}.`
      : `Launched ${launched} of ${total} ${total === 1 ? "run" : "runs"}.`;
  return `${count} Part of this launch failed: ${
    /[.!?]$/.test(sentence) ? sentence : `${sentence}.`
  }`;
}

/**
 * The 409 case: the backend refused a run whose split had moved.
 *
 * The counts are that RUN's (`totalConversations` is its size, not the launch's),
 * so they are said to belong to it: "now 0 of 1" beside a 15-conversation split
 * reads as a contradiction. The remaining runs are pointed back to New swarm,
 * the only place the split is shown and checked: Goals launches a run with no
 * preview, which would start them on a split nobody looked at.
 */
export function fundingChangedNotice(args: {
  launched: number;
  total: number;
  actualSponsored: number;
  totalConversations: number;
}): string {
  const refused = `${args.actualSponsored.toLocaleString()} of its ${plural(
    args.totalConversations,
    "conversation",
    "conversations",
  )} sponsored`;
  return args.launched === 0
    ? `Sponsored conversations changed before this launch started: a run now has ${refused}. Nothing was launched and nothing was moved to org credits. Review the split, then launch again.`
    : `Launched ${args.launched} of ${args.total} runs. Sponsored conversations changed for the next run (it now has ${refused}), so the remaining runs were not started and none were moved to org credits. Review the split in New swarm before launching them.`;
}
