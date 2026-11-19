/**
 * Switches for HARN-130's hosted startup trials, each read per call so an
 * operator can turn one off without a deploy. Every one only reorders or skips
 * work whose result cannot change: none touches authorization, credentials,
 * ownership or the prompt.
 */
import { HARNESS_BAKE_HOME, HARNESS_STATE_DIRECTORY_NAME } from "./harness-bake.js";

/** `MCPJAM_HARNESS_READ_AHEAD=background`: the page-cache hint no longer holds the session. */
export function readAheadInBackground(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MCPJAM_HARNESS_READ_AHEAD?.trim().toLowerCase() === "background";
}

/** `MCPJAM_HARNESS_MEMO_HOME=1`: a box's `$HOME` is asked for once per box. */
export function memoizeSandboxHome(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MCPJAM_HARNESS_MEMO_HOME === "1";
}

/** `MCPJAM_HARNESS_EARLY_REAP=1`: a fresh session's bridge reap runs during setup. */
export function reapBridgesEarly(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MCPJAM_HARNESS_EARLY_REAP === "1";
}

/** `MCPJAM_HARNESS_PARALLEL_ATTACH=1`: a broker-prepared attach reads the box and its policy together. */
export function attachInParallel(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MCPJAM_HARNESS_PARALLEL_ATTACH === "1";
}

/** The command the harness framework uses to learn a box's home directory. */
export const SANDBOX_HOME_COMMAND = 'printf "%s" "$HOME"';

const MAX_REMEMBERED_HOMES = 500;
const sandboxHomes = new Map<string, string>();

/** A box's home directory, once one command has reported it. */
export function rememberedSandboxHome(sandboxId: string): string | undefined {
  return sandboxHomes.get(sandboxId);
}

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
 * The state dir an early reap runs as. It names no session, so the reap stops
 * only bridges that are between turns, exactly what a fresh session's own reap
 * would stop: a fresh session has no older bridge of its own to supersede.
 */
export const EARLY_REAP_STATE_DIR = `${HARNESS_BAKE_HOME}/${HARNESS_STATE_DIRECTORY_NAME}/.agent-runs/.early-reap/bridge`;
