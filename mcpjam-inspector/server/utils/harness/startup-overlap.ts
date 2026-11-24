/**
 * How a hosted harness turn's startup avoids waiting on work it doesn't need
 * yet. Each piece only reorders or skips work whose result can't change; none
 * touches authorization, credentials, ownership or the prompt.
 */
import { logger } from "../logger.js";

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
 * Lets the runtime's page-cache hint run on its own while the session starts,
 * instead of holding the session. It only reads files, never fails a turn,
 * and rejects only when the turn is cancelled.
 */
export function readAheadInBackground(readAhead: Promise<void>): void {
  void readAhead.catch((error: unknown) => {
    logger.debug("[harness][read-ahead] background hint stopped", {
      reason: error instanceof Error ? error.name : "unknown",
    });
  });
}

/**
 * The lookup for a command that only asks for the box's home, which can't
 * change while the box lives: the home once a run has reported it, and a way
 * to keep a run's answer. Undefined for any other command, or one whose
 * environment sets HOME.
 */
export function sandboxHomeLookup(args: {
  sandboxId: string;
  command: string;
  setsHome: boolean;
}):
  | { known: string | undefined; keep(exitCode: number, stdout: string): void }
  | undefined {
  if (args.command !== SANDBOX_HOME_COMMAND || args.setsHome) return undefined;
  return {
    known: rememberedSandboxHome(args.sandboxId),
    keep(exitCode, stdout) {
      if (exitCode === 0) rememberSandboxHome(args.sandboxId, stdout);
    },
  };
}

/**
 * When a session's bridge spawns stop the box's other bridges. A turn on a
 * box no turn has used, where no bridge can be running, skips its first
 * spawn's reap. Later spawns, and every other session, reap.
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
      if (first && args.unusedBox?.() === true) return;
      await args.reap(stateDir, signal);
    },
  };
}
