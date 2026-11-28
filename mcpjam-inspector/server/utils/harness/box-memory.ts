/**
 * How much memory a harness box has, read from inside the box, and what a
 * turn says when that is not enough.
 *
 * A box booted from E2B's `base` image (no `E2B_TEMPLATE_ID` on the
 * deployment) has 512 MiB, of which the kernel reports 473 MiB. OpenCode does
 * not fit there. Its turn-time `pnpm install` holds both ~185 MB Linux x64
 * builds (`opencode-linux-x64` and its `-baseline` twin) while it extracts
 * them, then reads the binary OpenCode's install script copies back into the
 * side-effects cache. On `base` boxes pnpm reached 400 MB and the kernel's
 * out-of-memory killer stopped it, or the box thrashed until the command
 * timed out. pnpm settings that save memory (one download at a time, no
 * side-effects cache) still failed most runs, and `opencode serve` alone
 * holds 330 MB there. The same install peaks at 714 MiB on a 1 GiB box.
 *
 * E2B reports a command a signal stopped as exit `-1`, with the signal only in
 * the result's `error` field. The framework's bootstrap error quotes the exit
 * code and the command's output, never that field.
 */
import { logger } from "../logger.js";
import { HarnessInfraSetupError } from "./harness-provider-error.js";

/** Read-only and unprivileged: `oom_kill` counts the kernel's OOM kills. */
export const BOX_MEMORY_COMMAND =
  "grep -hE '^(MemTotal:|oom_kill )' /proc/meminfo /proc/vmstat";

const BOX_MEMORY_TIMEOUT_MS = 5_000;

/**
 * The smallest box, in MiB of `MemTotal`, each harness installs and runs on.
 * 900 admits a 1 GiB box (976 MiB) and refuses `base` (473 MiB). Harnesses
 * that are not listed run on any box.
 */
const MIN_BOX_MEMORY: Readonly<Record<string, { mib: number; name: string }>> =
  { opencode: { mib: 900, name: "OpenCode" } };

export interface BoxMemory {
  totalMiB?: number;
  oomKills?: number;
}

type RunInBox = (
  command: string,
  options: { timeoutMs: number; signal?: AbortSignal },
) => PromiseLike<{ stdout: string }>;

export function parseBoxMemory(stdout: string): BoxMemory {
  const total = /^MemTotal:\s+(\d+)\s+kB/m.exec(stdout);
  const kills = /^oom_kill\s+(\d+)/m.exec(stdout);
  return {
    ...(total ? { totalMiB: Math.floor(Number(total[1]) / 1024) } : {}),
    ...(kills ? { oomKills: Number(kills[1]) } : {}),
  };
}

/** `undefined` when the box could not be read: callers then decide nothing. */
export async function readBoxMemory(
  run: RunInBox,
  signal?: AbortSignal,
): Promise<BoxMemory | undefined> {
  try {
    const result = await run(BOX_MEMORY_COMMAND, {
      timeoutMs: BOX_MEMORY_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    return parseBoxMemory(result.stdout);
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn("[harness][box-memory] could not read the box's memory", {
      reason: error instanceof Error ? error.name : "unknown",
    });
    return undefined;
  }
}

/**
 * Refuses a harness whose install and runtime do not fit the box, before the
 * framework spends minutes on an install the kernel will kill. A box whose
 * memory cannot be read is let through: the install still reports itself.
 */
export async function assertBoxMemoryForHarness(
  run: RunInBox,
  harnessId: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const floor = harnessId ? MIN_BOX_MEMORY[harnessId] : undefined;
  if (!floor) return;
  const memory = await readBoxMemory(run, signal);
  if (memory?.totalMiB === undefined || memory.totalMiB >= floor.mib) return;
  throw new HarnessInfraSetupError(
    `Couldn't start ${floor.name} on this computer. It has ${memory.totalMiB} MiB ` +
      `of memory, and ${floor.name} needs at least 1 GiB to install and run. ` +
      `Use a computer built from the MCPJam computer template (E2B_TEMPLATE_ID ` +
      `on the deployment), or pick another client.`,
    { source: "sandbox_setup", code: "box_memory_too_small" },
  );
}

/** What E2B reports for a command SIGKILL stopped: the only signal the OOM killer sends. */
const SIGKILL = "signal: killed";

/**
 * The stderr a command result carries, plus why E2B stopped it when a signal
 * did (exit `-1`).
 *
 * The kernel's `oom_kill` counter is box-wide and only grows, so it cannot
 * say which process was killed. A SIGKILL on a box whose kernel has killed
 * for memory is reported as a likely out-of-memory kill, never as a certain
 * one, and any other signal never mentions memory.
 */
export async function stderrWithStopReason(
  result: { exitCode: number; error?: string | undefined; stderr: string },
  run: RunInBox,
  signal?: AbortSignal,
): Promise<string> {
  if (result.exitCode >= 0 || !result.error) return result.stderr;
  const memory =
    result.error === SIGKILL ? await readBoxMemory(run, signal) : undefined;
  const kills = memory?.oomKills ?? 0;
  const note =
    kills > 0 && memory?.totalMiB !== undefined
      ? `The sandbox killed this command (${result.error}). The box's kernel ` +
        `has stopped ${kills} ${kills === 1 ? "process" : "processes"} for ` +
        `lack of memory since it booted, so this command likely ran out of ` +
        `memory. The box has ${memory.totalMiB} MiB. Run this client on a ` +
        `computer with more memory, such as one built from the MCPJam ` +
        `computer template.`
      : `The sandbox stopped this command before it finished (${result.error}).`;
  return result.stderr.trim() ? `${result.stderr.trimEnd()}\n${note}` : note;
}
