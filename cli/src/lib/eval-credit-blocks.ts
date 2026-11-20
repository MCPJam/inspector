import {
  creditRecoveryOfIterations,
  formatCreditRecovery,
  incompleteCasesOfRun,
  isCreditBlock,
  parseCreditRecovery,
  readEvalRunCreditRecovery,
  readEvalRunIncompleteCases,
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
  idempotencyKeyOfErrorDetails,
  resumeReadsStdin,
  suiteIdOfErrorDetails,
  type EvalRunLaunchOptions,
} from "./eval-resume.js";
import { EVAL_RUN_BLOCKED_EXIT_CODE, worstOf } from "./eval-run-exit-code.js";

/**
 * One target of an `eval run` that MCPJam credits blocked with a step a person
 * must take: refused before its run existed, or stopped partway. Each carries
 * the command that resumes it, so the agent never has to invent one. The
 * refused targets of one fan-out share one command, the replay of that launch.
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
  /** The resume reads the suite file from stdin, which must be piped again. */
  pipeAgain?: true;
}

/** A run's credit stop, read from the run record or its trials. */
export interface RunCreditStop {
  run: PlatformEvalRun;
  recovery: CreditRecovery;
  incompleteCases?: IncompleteEvalCases;
}

/** True when the launch named its targets with flags rather than its file. */
function namesTargets(options: EvalRunLaunchOptions): boolean {
  return Boolean(
    options.server?.length ||
      options.environment?.length ||
      options.client?.length ||
      options.host?.length ||
      options.allTargets ||
      options.composeClient ||
      options.composeHost,
  );
}

/**
 * The refused targets of a launch receipt that a person must unblock. They
 * share ONE resume: the same launch replayed under the same group key, which
 * the server turns into the same per-target run keys, so the targets that
 * started return their existing runs and only the refused ones launch. A
 * `--file -` launch replays on its suite by id (stdin was consumed), naming
 * the receipt's targets when the file, not a flag, had chosen them.
 */
export function refusedTargetCreditBlocks(
  result: RunEvalSuiteResult,
  options: EvalRunLaunchOptions,
): CreditBlock[] {
  const refused = result.targets.flatMap((target) => {
    if (target.status !== "failed") return [];
    const recovery = parseCreditRecovery(target.error.recovery);
    return isCreditBlock(recovery) ? [{ target, recovery }] : [];
  });
  if (refused.length === 0) return [];
  const fileChoseTargets = options.file === "-" && !namesTargets(options);
  const replay: EvalRunLaunchOptions = fileChoseTargets
    ? {
        ...options,
        environment: result.targets.flatMap((target) =>
          !target.host && target.environment ? [target.environment.id] : [],
        ),
        client: result.targets.flatMap((target) =>
          target.host ? [target.host.id] : [],
        ),
      }
    : options;
  const resumeCommand = buildResumeCommand(replay, {
    idempotencyKey: options.idempotencyKey ?? result.idempotencyKey,
    suiteId: result.suite.id,
  });
  return refused.map(({ target, recovery }) => {
    const targetId = target.environment?.id ?? target.host?.id ?? "";
    const name = target.host?.name || target.environment?.name;
    return {
      target: name ? `${name} (${targetId})` : targetId,
      recovery,
      resumeCommand,
    };
  });
}

/**
 * The block of a single launch credits refused before it created a run: the
 * same launch replayed with the key and, for a `--file` launch, the suite the
 * thrown error's `details` recorded.
 */
export function refusedLaunchCreditBlock(
  details: unknown,
  recovery: CreditRecovery,
  options: EvalRunLaunchOptions,
): CreditBlock {
  const suiteId = suiteIdOfErrorDetails(details);
  return {
    target: "",
    recovery,
    resumeCommand: buildResumeCommand(options, {
      idempotencyKey: idempotencyKeyOfErrorDetails(details),
      suiteId,
    }),
    ...(resumeReadsStdin(options, suiteId) ? { pipeAgain: true as const } : {}),
  };
}

/** A stopped run's block, resumed with `--resume-from` on its own suite. */
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
      ...resumeSourceOfRun(run),
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
        ? incompleteCasesOfRun(run, trials.iterations, !trials.complete)
        : await readEvalRunIncompleteCases(client, signal, projectId, run);
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
 * fan-out refused for one reason says it once), then each distinct `Resume:`
 * command once, named by the targets it resumes when there are several, and
 * what each stopped run left unfinished. Under `--resume` the user already
 * said they took the step, so it prints `Still blocked:` and no command: the
 * CLI never retries on its own.
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
  const targetsByCommand = new Map<string, string[]>();
  for (const block of blocks) {
    const targets = targetsByCommand.get(block.resumeCommand) ?? [];
    targetsByCommand.set(block.resumeCommand, [...targets, block.target]);
  }
  const printed = new Set<string>();
  for (const block of blocks) {
    if (!resumed && !printed.has(block.resumeCommand)) {
      printed.add(block.resumeCommand);
      const targets = targetsByCommand.get(block.resumeCommand)!;
      const label = targetsByCommand.size > 1 ? ` ${targets.join(", ")}` : "";
      destination.write(`Resume${label}: ${block.resumeCommand}\n`);
      if (block.pipeAgain) {
        destination.write(
          "Pipe the same suite file to it again: the first launch read stdin.\n",
        );
      }
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
    ...(block.pipeAgain && !resumed ? { resumeReadsStdin: true as const } : {}),
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
 * The exit code of a launch that did not wait. Without a credit block, a
 * target that failed for any reason exits 1 (a partial launch is not a
 * success). With one, each other failure is classified first, as the `--wait`
 * path does: no run exists, so it is a setup failure (4), never a verdict, and
 * the block a person must clear (6) outranks it. 0 when nothing failed.
 */
export function launchCreditExitCode(
  result: Pick<RunEvalSuiteResult, "failedCount">,
  refusedBlocks: readonly CreditBlock[],
): number {
  const otherFailures = result.failedCount > refusedBlocks.length;
  if (refusedBlocks.length === 0) return otherFailures ? 1 : 0;
  return worstOf([otherFailures ? 4 : 0, EVAL_RUN_BLOCKED_EXIT_CODE]);
}
