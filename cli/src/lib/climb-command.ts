/**
 * What the climb commands share: parsing the flags a climb takes, and the
 * bounded `--wait` that polls a climb until it leaves a state.
 */
import {
  MAX_ROUND_WAIT_SECONDS,
  confirmClimbOperation,
  getClimbOperation,
  getClimbRoundOperation,
  type ConfirmClimbInput,
} from "@mcpjam/sdk/platform";
import { usageError } from "./output.js";

/** A number flag, or a usage error that names the flag. */
export function parseNumberOption(
  value: string | undefined,
  flag: string,
  bounds?: { min?: number; max?: number; exclusiveMin?: number }
): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
  if (!Number.isFinite(parsed)) throw usageError(`${flag} must be a number`);
  if (bounds?.min !== undefined && parsed < bounds.min) throw usageError(`${flag} must be at least ${bounds.min}`);
  if (bounds?.exclusiveMin !== undefined && parsed <= bounds.exclusiveMin) {
    throw usageError(`${flag} must be more than ${bounds.exclusiveMin}`);
  }
  if (bounds?.max !== undefined && parsed > bounds.max) throw usageError(`${flag} must be at most ${bounds.max}`);
  return parsed;
}

/** A comma-separated flag as a list, or undefined when it was not given. */
export function parseListOption(value: string | undefined, flag: string): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) throw usageError(`${flag} needs at least one value, separated by commas`);
  return items;
}

export const WAIT_FLAG = "--wait";
export const WAIT_SECONDS_FLAG = "--wait-seconds <n>";
export const WAIT_SECONDS_DEFAULT = 1800;
const POLL_MS = 10_000;

type Context = Parameters<typeof getClimbOperation.execute>[1];
type Climb = Awaited<ReturnType<typeof getClimbOperation.execute>>;

/**
 * With `--wait`, reads the climb every ten seconds until `done` says it has
 * gone as far as it will on its own, or the bound passes. A wait that runs out
 * returns what it last read: the climb keeps running, and the same command can
 * be run again.
 */
export async function waitForClimb<TResult extends { climbId: string }>(
  result: TResult,
  wait: { wait?: boolean; waitSeconds?: number; project?: string },
  context: Context,
  done: (climb: Climb) => boolean,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<TResult | Climb> {
  if (!wait.wait) return result;
  const deadline = Date.now() + (wait.waitSeconds ?? WAIT_SECONDS_DEFAULT) * 1000;
  for (;;) {
    const climb = await getClimbOperation.execute({ project: wait.project, climb: result.climbId }, context);
    if (done(climb) || Date.now() >= deadline) return climb;
    await sleep(POLL_MS);
  }
}

type Round = Awaited<ReturnType<typeof getClimbRoundOperation.execute>>;

/**
 * With `--wait`, reads a round until it has settled or the bound passes, in
 * holds of at most a minute (the operation's own bound), so no single call
 * outlives what a surface allows. Returns the round as last read: `settled`
 * says whether it finished.
 */
export async function waitForRound(
  round: { climb: string; round: number; project?: string },
  wait: { wait?: boolean; waitSeconds?: number },
  context: Context
): Promise<Round> {
  const deadline = Date.now() + (wait.waitSeconds ?? WAIT_SECONDS_DEFAULT) * 1000;
  for (;;) {
    const hold = wait.wait ? Math.min(MAX_ROUND_WAIT_SECONDS, Math.max(0, Math.floor((deadline - Date.now()) / 1000))) : 0;
    const read = await getClimbRoundOperation.execute({ ...round, waitSeconds: hold }, context);
    if (read.settled || !wait.wait || Date.now() >= deadline) return read;
  }
}

/**
 * `confirm --wait`: the call holds in bounds of at most a minute until the
 * confirmation has settled, and the first call alone launches it. A call that
 * comes back unsettled is read again with `climbs get`, which holds the result.
 */
export async function waitForConfirmation(
  input: ConfirmClimbInput & { wait?: boolean; waitSeconds?: number },
  context: Context
): Promise<Awaited<ReturnType<typeof confirmClimbOperation.execute>>> {
  const { wait, waitSeconds, ...confirm } = input;
  const hold = wait && !confirm.dryRun ? Math.min(MAX_ROUND_WAIT_SECONDS, waitSeconds ?? WAIT_SECONDS_DEFAULT) : 0;
  const confirmed = await confirmClimbOperation.execute({ ...confirm, waitSeconds: hold }, context);
  const deadline = Date.now() + (waitSeconds ?? WAIT_SECONDS_DEFAULT) * 1000;
  while (wait && !confirmed.dryRun && !confirmed.settled && Date.now() < deadline) {
    const climb = await getClimbOperation.execute({ project: input.project, climb: input.climb }, context);
    if (climb.confirmationResult?.status === "settled") return { ...confirmed, settled: true, result: climb.confirmationResult };
    if (climb.confirmation?.status === "failed") return confirmed;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  return confirmed;
}
