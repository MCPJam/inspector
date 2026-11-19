import {
  type CreditRecovery,
  creditRecoveryOfRefusal,
  formatCreditRecovery,
} from "@mcpjam/sdk/contract";

/**
 * When MCPJam credits refuse a launch or stop a run partway, the one step the
 * refusal names is only useful if the agent can act on it without inventing a
 * command. These helpers turn the parsed launch options back into the exact
 * `mcpjam cloud eval run …` to run once the user has topped up, and decide
 * whether the refusal is a person-must-act block (exit 6) or a `wait` that
 * clears on its own (keeps its old code).
 *
 * A `wait` recovery is NOT a block: steering an agent toward waiting is the
 * exact behavior KES-941 removes. Every other action — upgrade, buy credits,
 * raise the budget, ask an admin, contact support — needs a person, so it is a
 * block and the CLI prints one action and one resume command.
 */

/** True when the refusal names a step a PERSON must take (anything but `wait`). */
export function isCreditBlock(
  recovery: CreditRecovery | undefined
): recovery is CreditRecovery {
  return recovery !== undefined && recovery.action !== "wait";
}

/**
 * The credit recovery a thrown launch refusal carried, read from the CLI
 * error's `details` (the refusal envelope the server sent). `undefined` for
 * anything that is not a credit refusal, so an ordinary failure stays ordinary.
 */
export function creditRecoveryOfCliError(error: unknown): CreditRecovery | undefined {
  const details = (error as { details?: unknown } | null)?.details;
  return creditRecoveryOfRefusal(details);
}

/** The launch options this module reconstructs a resume command from. */
export interface EvalRunLaunchOptions {
  suite?: string;
  file?: string;
  project?: string;
  server?: string[];
  environment?: string[];
  client?: string[];
  host?: string[];
  allTargets?: boolean;
  iterations?: number;
  repetitions?: number;
  case?: string[];
  excludeSkills?: boolean;
  refreshSnapshot?: boolean;
  notes?: string;
  minPassRate?: number;
  matchOptions?: string;
  idempotencyKey?: string;
  composeClient?: string;
  composeHost?: string;
  composeComputer?: string;
  composeModel?: string[];
  composeModelSelection?: string[];
  withClientDefault?: boolean;
  saveTargets?: boolean;
  composeServer?: string[];
  composeServerGroup?: string;
  composeSkill?: string[];
  composeSecret?: string[];
  allowApproximated?: string[];
  approvalReason?: string;
  wait?: boolean;
  waitTimeout?: string;
  reporter?: string;
  out?: string;
}

/**
 * The idempotency key a launch error carried in its `details` (the file path
 * mints one and records it there), or `undefined`. Lets a refused-launch resume
 * command reuse the key that launch would have used.
 */
export function idempotencyKeyOfErrorDetails(
  details: unknown
): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const key = (details as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

/** A plain token needs no quoting; anything else is single-quoted, safely. */
const SAFE_TOKEN = /^[A-Za-z0-9._:/@=+,-]+$/;

export function shellQuoteArg(arg: string): string {
  if (SAFE_TOKEN.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * The `mcpjam cloud eval run …` to run after the user tops up credits.
 *
 * A refused launch created no run, so resuming is the same launch again with
 * the same `--idempotency-key` (reusing it is safe — no run was created for it)
 * plus `--resume`. A run that stopped partway is resumed with `--resume
 * --resume-from <runId>`, which runs only the source run's unfinished cases;
 * the key is dropped there because reusing it would return the stopped run
 * instead of starting the resume.
 *
 * Secrets never appear: `--api-key`, `--api-header` and `--api-url` are not
 * reconstructed. Arguments are quoted so a value with spaces or JSON survives a
 * paste into a shell unchanged.
 */
export function buildResumeCommand(
  options: EvalRunLaunchOptions,
  resume: { sourceRunId?: string; idempotencyKey?: string } = {}
): string {
  const argv: string[] = ["mcpjam", "cloud", "eval", "run"];
  const push = (...tokens: string[]) => argv.push(...tokens);
  const pushEach = (flag: string, values: readonly string[] | undefined) => {
    for (const value of values ?? []) push(flag, value);
  };

  if (options.file) push("--file", options.file);
  else if (options.suite) push("--suite", options.suite);
  if (options.project) push("--project", options.project);

  pushEach("--server", options.server);
  pushEach("--environment", options.environment);
  // `--host` is the deprecated alias of `--client`; emit one canonical flag.
  pushEach("--client", [...(options.client ?? []), ...(options.host ?? [])]);
  if (options.allTargets) push("--all-targets");

  const iterations = options.iterations ?? options.repetitions;
  if (iterations !== undefined) push("--iterations", String(iterations));
  pushEach("--case", options.case);
  if (options.excludeSkills) push("--exclude-skills");
  if (options.refreshSnapshot) push("--refresh-snapshot");
  if (options.notes !== undefined) push("--notes", options.notes);
  if (options.minPassRate !== undefined)
    push("--min-pass-rate", String(options.minPassRate));
  if (options.matchOptions !== undefined)
    push("--match-options", options.matchOptions);

  const composeClient = options.composeClient ?? options.composeHost;
  if (composeClient) push("--compose-client", composeClient);
  if (options.composeComputer)
    push("--compose-computer", options.composeComputer);
  pushEach("--compose-model", options.composeModel);
  pushEach("--compose-model-selection", options.composeModelSelection);
  if (options.withClientDefault) push("--with-client-default");
  if (options.saveTargets) push("--save-targets");
  pushEach("--compose-server", options.composeServer);
  if (options.composeServerGroup)
    push("--compose-server-group", options.composeServerGroup);
  pushEach("--compose-skill", options.composeSkill);
  pushEach("--compose-secret", options.composeSecret);
  pushEach("--allow-approximated", options.allowApproximated);
  if (options.approvalReason !== undefined)
    push("--approval-reason", options.approvalReason);

  if (options.wait) push("--wait");
  if (options.waitTimeout !== undefined)
    push("--wait-timeout", options.waitTimeout);
  if (options.reporter !== undefined) push("--reporter", options.reporter);
  if (options.out !== undefined) push("--out", options.out);

  if (resume.sourceRunId) {
    push("--resume", "--resume-from", resume.sourceRunId);
  } else {
    const key = resume.idempotencyKey ?? options.idempotencyKey;
    if (key) push("--idempotency-key", key);
    push("--resume");
  }

  return argv.map(shellQuoteArg).join(" ");
}

/** The JSON fields a credit block adds to a receipt or an error document. */
export function creditBlockJsonFields(
  resumeCommand: string,
  resumed: boolean
): { resumeCommand: string } | { stillBlocked: true } {
  return resumed ? { stillBlocked: true } : { resumeCommand };
}

/**
 * The human lines for a credit block. A first refusal prints the one step and
 * the resume command to run after the user tops up; a refusal that happened
 * UNDER `--resume` (the user already said they fixed it, and it is still
 * refused) prints `Still blocked` and no command — the CLI never retries on its
 * own.
 */
export function writeCreditBlockGuidance(
  format: string,
  args: { recovery: CreditRecovery; resumeCommand: string; resumed: boolean },
  destination: Pick<NodeJS.WriteStream, "write"> = process.stdout
): void {
  if (format !== "human") return;
  const sentence = formatCreditRecovery(args.recovery);
  if (args.resumed) {
    destination.write(`Still blocked: ${sentence}\n`);
    return;
  }
  destination.write(`Recovery: ${sentence}\n`);
  destination.write(`Resume: ${args.resumeCommand}\n`);
}
