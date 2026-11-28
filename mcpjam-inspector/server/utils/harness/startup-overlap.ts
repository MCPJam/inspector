/**
 * Operator switches that shorten a hosted harness turn's startup. Each only
 * reorders or skips work whose result can't change; none touches
 * authorization, credentials, ownership or the prompt. All are off by default
 * and read per call, so an operator can turn one off without a deploy.
 */
import { logger } from "../logger.js";

/** `MCPJAM_HARNESS_READ_AHEAD=background`: the page-cache hint no longer holds the session. */
export function readAheadInBackground(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.MCPJAM_HARNESS_READ_AHEAD?.trim().toLowerCase() === "background";
}

/** `MCPJAM_HARNESS_MEMO_HOME=1`: a box's `$HOME` is asked for once per box. */
export function memoizeSandboxHome(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.MCPJAM_HARNESS_MEMO_HOME === "1";
}

/** `MCPJAM_HARNESS_OVERLAP_MCP_CONFIG=1`: mint a turn's MCP configuration while its broker starts. */
export function overlapMcpConfigWithBroker(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.MCPJAM_HARNESS_OVERLAP_MCP_CONFIG === "1";
}

/** `MCPJAM_HARNESS_SKIP_FIRST_REAP=1`: a conversation's first turn, on its new box, reaps no bridges. */
export function skipFirstTurnReap(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.MCPJAM_HARNESS_SKIP_FIRST_REAP === "1";
}

/** The command the harness framework uses to learn a box's home directory. */
export const SANDBOX_HOME_COMMAND = 'printf "%s" "$HOME"';

const MAX_REMEMBERED_HOMES = 500;
const sandboxHomes = new Map<string, string>();

/** A box's home directory, once one command has reported it. */
export function rememberedSandboxHome(sandboxId: string): string | undefined {
  return sandboxHomes.get(sandboxId);
}

/** Keeps a reported home, if it looks like one; the oldest go first past the cap. */
export function rememberSandboxHome(sandboxId: string, home: string): void {
  if (!home.startsWith("/") || home.includes("\n")) return;
  sandboxHomes.delete(sandboxId);
  sandboxHomes.set(sandboxId, home);
  if (sandboxHomes.size > MAX_REMEMBERED_HOMES) {
    const oldest = sandboxHomes.keys().next().value;
    if (oldest !== undefined) sandboxHomes.delete(oldest);
  }
}

/**
 * The read-ahead a session waits for before it starts. With
 * `MCPJAM_HARNESS_READ_AHEAD=background` that is none: the hint keeps warming
 * the runtime's pages on its own while the session starts. It only reads
 * files, never fails a turn, and rejects only when the turn is cancelled.
 */
export function readAheadToAwait(readAhead: Promise<void>): Promise<void>[] {
  if (!readAheadInBackground()) return [readAhead];
  void readAhead.catch((error: unknown) => {
    logger.debug("[harness][read-ahead] background hint stopped", {
      reason: error instanceof Error ? error.name : "unknown",
    });
  });
  return [];
}

/**
 * With `MCPJAM_HARNESS_MEMO_HOME`, the lookup for a command that only asks for
 * the box's home, which can't change while the box lives: the home once a run
 * has reported it, and a way to keep a run's answer. Undefined for any other
 * command, or one whose environment sets HOME.
 */
export function sandboxHomeLookup(args: {
  sandboxId: string;
  command: string;
  setsHome: boolean;
}):
  | { known: string | undefined; keep(exitCode: number, stdout: string): void }
  | undefined {
  if (!memoizeSandboxHome() || args.command !== SANDBOX_HOME_COMMAND || args.setsHome)
    return undefined;
  return {
    known: rememberedSandboxHome(args.sandboxId),
    keep(exitCode, stdout) {
      if (exitCode === 0) rememberSandboxHome(args.sandboxId, stdout);
    },
  };
}

/**
 * When a session's bridge spawns stop the box's other bridges. With
 * `MCPJAM_HARNESS_SKIP_FIRST_REAP`, a turn on a box no turn has used, where no
 * bridge can be running, skips its first spawn's reap. Later spawns, and every
 * other session, reap as before.
 */
export function bridgeReapSchedule(args: {
  reap: (stateDir: string, signal?: AbortSignal) => Promise<void>;
  unusedBox?: () => boolean;
}): { beforeSpawn(stateDir: string, signal?: AbortSignal): Promise<void> } {
  let spawned = false;
  return {
    async beforeSpawn(stateDir, signal) {
      const first = !spawned;
      spawned = true;
      if (first && skipFirstTurnReap() && args.unusedBox?.() === true)
        return;
      await args.reap(stateDir, signal);
    },
  };
}
