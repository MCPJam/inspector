import {
  creditRecoveryOfIterations,
  formatCreditRecovery,
  incompleteCasesOfIterations,
  isCreditBlock,
  parseCreditRecovery,
  readEvalRunCreditRecovery,
  readEvalRunIncompleteCases,
  resumeIdempotencyKeyForTarget,
  resumeSourceOfRun,
  type CreditRecovery,
  type IncompleteEvalCases,
} from "@mcpjam/sdk";
import type {
  PlatformApiClient,
  PlatformEvalIteration,
  PlatformEvalRun,
  RunEvalSuiteResult,
} from "@mcpjam/sdk/platform";
import {
  buildResumeCommand,
  type EvalRunLaunchOptions,
} from "./eval-resume.js";
import { EVAL_RUN_BLOCKED_EXIT_CODE, worstOf } from "./eval-run-exit-code.js";

/**
 * One target of an `eval run` that MCPJam credits blocked with a step a person
 * must take: refused before its run existed, or stopped partway. Each carries
 * its own resume command, so a fan-out where two targets were blocked prints
 * two commands and the agent never has to invent one.
 */
export interface CreditBlock {
  /** The target in the caller's words, for a fan-out's per-target lines. */
  target: string;
  /** Set for a run that stopped partway; absent for a refused launch. */
  runId?: string;
  recovery: CreditRecovery;
  resumeCommand: string;
  /** The cases the resume will run, for a stopped run. */
  incompleteCases?: IncompleteEvalCases;
}

/** A run's credit stop, read from the run record or its trials. */
export interface RunCreditStop {
  run: PlatformEvalRun;
  recovery: CreditRecovery;
  incompleteCases?: IncompleteEvalCases;
}

/** The launch knobs a per-target re-launch must not repeat. */
const PER_TARGET_DROPPED: Partial<EvalRunLaunchOptions> = {
  file: undefined,
  server: undefined,
  environment: undefined,
  client: undefined,
  host: undefined,
  allTargets: undefined,
  composeClient: undefined,
  composeHost: undefined,
  composeComputer: undefined,
  composeModel: undefined,
  composeModelSelection: undefined,
  withClientDefault: undefined,
  saveTargets: undefined,
  composeServer: undefined,
  composeServerGroup: undefined,
  composeSkill: undefined,
  composeSecret: undefined,
};

/**
 * The refused targets of a launch receipt that a person must unblock. Each
 * resume re-launches that one target on the suite by id (a `--file` launch
 * already upserted it, and `--file -` would wait on consumed stdin), with a
 * per-target key so a second run of the command starts nothing new.
 */
export function refusedTargetCreditBlocks(
  result: RunEvalSuiteResult,
  options: EvalRunLaunchOptions,
): CreditBlock[] {
  const groupKey = options.idempotencyKey ?? result.idempotencyKey;
  return result.targets.flatMap((target) => {
    if (target.status !== "failed") return [];
    const recovery = parseCreditRecovery(target.error.recovery);
    if (!isCreditBlock(recovery)) return [];
    const environmentId = target.environment?.id;
    const hostId = target.host?.id;
    const targetId = environmentId ?? hostId ?? "";
    const resumeCommand = buildResumeCommand({
      ...options,
      ...PER_TARGET_DROPPED,
      suite: result.suite.id,
      ...(environmentId ? { environment: [environmentId] } : {}),
      ...(!environmentId && hostId ? { client: [hostId] } : {}),
      idempotencyKey: groupKey
        ? resumeIdempotencyKeyForTarget(groupKey, targetId)
        : undefined,
    });
    const name = target.host?.name || target.environment?.name;
    return [
      {
        target: name ? `${name} (${targetId})` : targetId,
        recovery,
        resumeCommand,
      },
    ];
  });
}

/** A stopped run's block, resumed with `--resume-from` on its own target. */
export function stoppedRunCreditBlock(
  stop: RunCreditStop,
  options: EvalRunLaunchOptions,
): CreditBlock {
  const { run } = stop;
  const name = run.client?.name || run.environment?.name;
  return {
    target: name ? `${name} (run ${run.id})` : `run ${run.id}`,
    runId: run.id,
    recovery: stop.recovery,
    resumeCommand: buildResumeCommand(options, {
      sourceRunId: run.id,
      source: resumeSourceOfRun(run),
    }),
    ...(stop.incompleteCases ? { incompleteCases: stop.incompleteCases } : {}),
  };
}

/**
 * Each waited run's credit stop, from the run record first, then the trials
 * the report walk already read, then one bounded read. Unfinished cases are
 * read only for a block, the one case where they say what the resume reruns.
 */
export async function readRunCreditStops(
  client: Pick<PlatformApiClient, "listEvalRunIterations">,
  signal: AbortSignal | undefined,
  projectId: string,
  runs: readonly PlatformEvalRun[],
  walked: ReadonlyMap<
    string,
    {
      iterations: readonly Pick<
        PlatformEvalIteration,
        "status" | "infraError" | "caseId" | "testCaseId" | "title"
      >[];
      complete: boolean;
    }
  > = new Map(),
): Promise<RunCreditStop[]> {
  const stops = await Promise.all(
    runs.map(async (run): Promise<RunCreditStop | undefined> => {
      const trials = walked.get(run.id);
      const recovery =
        parseCreditRecovery(run.creditRecovery) ??
        (trials
          ? creditRecoveryOfIterations(trials.iterations)
          : await readEvalRunCreditRecovery(client, signal, projectId, run));
      if (!recovery) return undefined;
      if (!isCreditBlock(recovery)) return { run, recovery };
      const incompleteCases = trials
        ? incompleteCasesOfIterations(trials.iterations, !trials.complete)
        : await readEvalRunIncompleteCases(client, signal, projectId, run.id);
      return { run, recovery, ...(incompleteCases ? { incompleteCases } : {}) };
    }),
  );
  return stops.filter((stop): stop is RunCreditStop => stop !== undefined);
}

function incompleteCasesLine(cases: IncompleteEvalCases): string | undefined {
  if (cases.cases.length === 0) return undefined;
  const names = cases.cases.map((entry) =>
    JSON.stringify(entry.title ?? entry.caseId ?? entry.testCaseId),
  );
  return (
    `Incomplete (the resume reruns these): ${names.join(", ")}` +
    (cases.truncated ? ", and more" : "") +
    "\n"
  );
}

/**
 * The human lines for credit blocks. Each distinct step is printed once (a
 * fan-out refused for one reason says it once), then one `Resume:` command
 * per blocked target, named by target when there are several, and what each
 * stopped run left unfinished. Under `--resume` the user already said they
 * took the step, so it prints `Still blocked:` and no command: the CLI never
 * retries on its own.
 */
export function writeCreditBlocks(
  format: string,
  blocks: readonly CreditBlock[],
  resumed: boolean,
  destination: Pick<NodeJS.WriteStream, "write"> = process.stdout,
): void {
  if (format !== "human" || blocks.length === 0) return;
  const sentences = new Set(
    blocks.map((block) => formatCreditRecovery(block.recovery)),
  );
  for (const sentence of sentences) {
    destination.write(
      `${resumed ? "Still blocked" : "Recovery"}: ${sentence}\n`,
    );
  }
  for (const block of blocks) {
    if (!resumed) {
      const label = blocks.length > 1 ? ` ${block.target}` : "";
      destination.write(`Resume${label}: ${block.resumeCommand}\n`);
    }
    const incomplete = block.incompleteCases
      ? incompleteCasesLine(block.incompleteCases)
      : undefined;
    if (incomplete) destination.write(incomplete);
  }
}

/** One block's JSON: the same fields for a solo launch and a fan-out target. */
function creditBlockJson(block: CreditBlock, resumed: boolean) {
  return {
    ...(resumed
      ? { stillBlocked: true as const }
      : { resumeCommand: block.resumeCommand }),
    ...(block.incompleteCases
      ? { incompleteCases: block.incompleteCases }
      : {}),
  };
}

/**
 * The JSON a launch's credit blocks add. A single-target launch puts its one
 * block's fields at the top level, beside its `creditRecovery`; a fan-out
 * lists every blocked target under `creditBlocks` with its own recovery.
 */
export function creditBlocksJsonFields(
  blocks: readonly CreditBlock[],
  resumed: boolean,
  solo: boolean,
) {
  if (blocks.length === 0) return {};
  if (solo && blocks.length === 1) return creditBlockJson(blocks[0]!, resumed);
  return {
    creditBlocks: blocks.map((block) => ({
      target: block.target,
      ...(block.runId ? { runId: block.runId } : {}),
      creditRecovery: block.recovery,
      ...creditBlockJson(block, resumed),
    })),
  };
}

/**
 * The exit code of a launch that did not wait: 1 when a target failed for a
 * reason other than a credit block (a partial launch is not a success), 6
 * when every failure is a block a person must clear, 0 otherwise.
 */
export function launchCreditExitCode(
  result: Pick<RunEvalSuiteResult, "failedCount">,
  refusedBlocks: readonly CreditBlock[],
): number {
  return worstOf([
    result.failedCount > refusedBlocks.length ? 1 : 0,
    refusedBlocks.length > 0 ? EVAL_RUN_BLOCKED_EXIT_CODE : 0,
  ]);
}
