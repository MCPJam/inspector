import {
  type CreditRecovery,
  creditRecoveryOfRefusal,
} from "@mcpjam/sdk/contract";

/**
 * When MCPJam credits refuse a launch or stop a run partway, the one step the
 * refusal names is only useful if the agent can act on it without inventing a
 * command. These helpers turn the parsed launch options back into the exact
 * `mcpjam cloud eval run …` to run once the user has topped up. Whether a
 * refusal is a block at all is `isCreditBlock` in the SDK: a `wait` is not,
 * because steering an agent toward waiting is what the one-action rule removes.
 */

/**
 * The credit recovery a thrown launch refusal carried, read from the CLI
 * error's `details` (the refusal envelope the server sent). `undefined` for
 * anything that is not a credit refusal, so an ordinary failure stays ordinary.
 */
export function creditRecoveryOfCliError(
  error: unknown,
): CreditRecovery | undefined {
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
  resumeFrom?: string;
}

/** A non-empty string field of a launch error's `details`, or `undefined`. */
function detailString(details: unknown, field: string): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = (details as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The idempotency key a launch error carried in its `details` (the file path
 * mints one and records it there), or `undefined`. Lets a refused-launch resume
 * command reuse the key that launch would have used.
 */
export function idempotencyKeyOfErrorDetails(
  details: unknown,
): string | undefined {
  return detailString(details, "idempotencyKey");
}

/** A field of the replay call the SDK put on a refusal's `details.resume`. */
function resumeArgument(details: unknown, field: string): string | undefined {
  const resume =
    details && typeof details === "object"
      ? (details as { resume?: { arguments?: unknown } }).resume
      : undefined;
  return detailString(resume?.arguments, field);
}

/**
 * The suite a refused launch resolved before credits refused it, from the
 * error's `details`: the suite a `--file` launch had already written, or the
 * one the replay call names. Its resume names the suite by id instead of
 * reading the file (or consumed stdin) or resolving a name again.
 */
export function suiteIdOfErrorDetails(details: unknown): string | undefined {
  return detailString(details, "suiteId") ?? resumeArgument(details, "suite");
}

/** The project a refused launch resolved, from the replay call in `details`. */
export function projectIdOfErrorDetails(details: unknown): string | undefined {
  return resumeArgument(details, "project");
}

/**
 * True when the resume command still reads the suite from stdin, which must be
 * piped again because the first launch consumed it: a refused `--file -`
 * launch whose suite id is unknown, or one that approved approximated cases.
 * Approvals name the file's authored cases, so only a file run accepts them.
 */
export function resumeReadsStdin(
  options: Pick<
    EvalRunLaunchOptions,
    "file" | "allowApproximated" | "resumeFrom"
  >,
  suiteId: string | undefined,
): boolean {
  if (options.file !== "-") return false;
  if (suiteId === undefined) return true;
  return (
    options.resumeFrom === undefined &&
    (options.allowApproximated?.length ?? 0) > 0
  );
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
 * the same `--idempotency-key` plus `--resume`, every selector and compose
 * flag included. For a fan-out the server derives each target's run key from
 * that group key, so targets that started come back as their existing runs
 * and only the refused ones launch. A refused `--file -` launch names its
 * suite by id when it is known, because stdin was consumed.
 *
 * A run that stopped partway is resumed on its suite with `--resume
 * --resume-from <runId>` and no target: the backend runs it on the source
 * run's own target, which a selector may not be able to name (a composed or
 * since-detached environment). The key is dropped there because reusing it
 * would return the stopped run instead of starting the resume.
 *
 * A refused launch that was itself `--resume-from` replays as that resume: the
 * same key and source run, and no target or case, since the source run decides
 * both. Without the source run the replay would start a fresh run and rerun
 * the cases that already finished.
 *
 * Secrets never appear: `--api-key`, `--api-header` and `--api-url` are not
 * reconstructed. Arguments are quoted so a value with spaces or JSON survives a
 * paste into a shell unchanged.
 */
export function buildResumeCommand(
  options: EvalRunLaunchOptions,
  resume: {
    sourceRunId?: string;
    idempotencyKey?: string;
    suiteId?: string;
    projectId?: string;
  } = {},
): string {
  const argv: string[] = ["mcpjam", "cloud", "eval", "run"];
  const push = (...tokens: string[]) => argv.push(...tokens);
  const pushEach = (flag: string, values: readonly string[] | undefined) => {
    for (const value of values ?? []) push(flag, value);
  };

  const stoppedResume = resume.sourceRunId !== undefined;
  const sourceRunId = resume.sourceRunId ?? options.resumeFrom;
  const resumesSource = sourceRunId !== undefined;

  // A stopped run already belongs to a suite, so its resume names that suite
  // by id: re-sending `--file` would re-upsert the cases first, and `--file -`
  // would wait on stdin that was consumed by the first launch. A `--suite`
  // launch names the suite and project it resolved, so funding the account
  // cannot switch which suite a name resolves to.
  const bySuiteId =
    resume.suiteId !== undefined &&
    (resumesSource ||
      options.file === undefined ||
      (options.file === "-" && !resumeReadsStdin(options, resume.suiteId)));
  if (bySuiteId) push("--suite", resume.suiteId!);
  else if (options.file) push("--file", options.file);
  else if (options.suite) push("--suite", options.suite);
  const project = resume.projectId ?? options.project;
  if (project) push("--project", project);

  // The server picks a stopped run's cases and target itself, and refuses
  // `--case` beside a resume, so a resume names neither.
  if (!resumesSource) {
    pushEach("--server", options.server);
    pushEach("--environment", options.environment);
    // `--host` is the deprecated alias of `--client`; emit one canonical flag.
    pushEach("--client", [...(options.client ?? []), ...(options.host ?? [])]);
    if (options.allTargets) push("--all-targets");
    pushEach("--case", options.case);
  }

  const iterations = options.iterations ?? options.repetitions;
  if (iterations !== undefined) push("--iterations", String(iterations));
  if (options.notes !== undefined) push("--notes", options.notes);
  if (options.minPassRate !== undefined)
    push("--min-pass-rate", String(options.minPassRate));

  if (!resumesSource) {
    if (options.excludeSkills) push("--exclude-skills");
    if (options.refreshSnapshot) push("--refresh-snapshot");
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
  }

  if (options.wait) push("--wait");
  if (options.waitTimeout !== undefined)
    push("--wait-timeout", options.waitTimeout);
  if (options.reporter !== undefined) push("--reporter", options.reporter);
  if (options.out !== undefined) push("--out", options.out);

  if (!stoppedResume) {
    const key = resume.idempotencyKey ?? options.idempotencyKey;
    if (key) push("--idempotency-key", key);
  }
  push("--resume");
  if (sourceRunId !== undefined) push("--resume-from", sourceRunId);

  return argv.map(shellQuoteArg).join(" ");
}
