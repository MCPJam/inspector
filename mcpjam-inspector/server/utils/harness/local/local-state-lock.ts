/**
 * Reusable cross-process serialization for owner-only local harness state.
 *
 * Atomic rename makes readers see a complete file, but it does not make a
 * read-modify-write sequence atomic. Every mutable state file gets its own
 * lock created with `wx`, plus an in-process promise chain so both Inspector
 * windows and concurrent calls inside one window serialize mutations.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../logger.js";

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_POLL_MS = 25;
const DEFAULT_TIMEOUT_MS = 45_000;

interface LockFileBody {
  pid: number;
  nonce: string;
  at: number;
}

export interface LocalStateMutationLockOptions {
  rootDir: () => string;
  lockFileName: string;
  resourceLabel: string;
  staleMs?: number;
  pollMs?: number;
  timeoutMs?: number;
}

async function readLockBody(file: string): Promise<LockFileBody | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const body = parsed as Partial<LockFileBody>;
    // Zero and negative pids have process-group semantics. Treat them as an
    // unattributable body rather than probing or signalling the wrong target.
    if (
      typeof body.pid !== "number" ||
      !Number.isInteger(body.pid) ||
      body.pid <= 0 ||
      typeof body.nonce !== "string" ||
      body.nonce.length === 0
    ) {
      return null;
    }
    return { pid: body.pid, nonce: body.nonce, at: Number(body.at) || 0 };
  } catch {
    return null;
  }
}

function lockHolderProvablyGone(body: LockFileBody | null): boolean {
  if (body === null || body.pid === process.pid) return false;
  try {
    process.kill(body.pid, 0);
    return false;
  } catch (error) {
    // EPERM means alive but not ours. Only ESRCH proves absence.
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Build one independent lock domain for a mutable local-state resource. */
export function createLocalStateMutationLock(
  options: LocalStateMutationLockOptions,
): <T>(operation: () => Promise<T>) => Promise<T> {
  let mutationChain: Promise<unknown> = Promise.resolve();
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const acquire = async (): Promise<() => Promise<void>> => {
    const root = options.rootDir();
    const file = join(root, options.lockFileName);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const nonce = randomUUID();
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      try {
        await writeFile(
          file,
          JSON.stringify({ pid: process.pid, nonce, at: Date.now() }),
          { flag: "wx", mode: 0o600 },
        );
        return async () => {
          const held = await readLockBody(file);
          if (held?.nonce !== nonce) {
            logger.warn(
              `[local-harness] ${options.resourceLabel} lock was taken over; ` +
                `not releasing`,
            );
            return;
          }
          await rm(file, { force: true }).catch(() => {});
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const body = await readLockBody(file);
        const age = await stat(file).then(
          (info) => Date.now() - info.mtimeMs,
          () => 0,
        );
        const holderGone = lockHolderProvablyGone(body);
        // A malformed body names nobody, so age is its only safe recovery
        // path. A valid body is never stolen merely for being old.
        const unattributable = body === null && age > staleMs;
        if (holderGone || unattributable) {
          logger.warn(
            `[local-harness] breaking an abandoned ${options.resourceLabel} lock`,
            { age, holderGone, unattributable },
          );
          await rm(file, { force: true }).catch(() => {});
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for the local harness ${options.resourceLabel} ` +
              `lock` +
              (body === null ? "" : ` (held by pid ${body.pid})`) +
              ". Its holder could not be proven gone, and taking it over " +
              "would admit concurrent state writers.",
          );
        }
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, pollMs),
        );
      }
    }
  };

  return <T>(operation: () => Promise<T>): Promise<T> => {
    const guarded = async (): Promise<T> => {
      const release = await acquire();
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const run = mutationChain.then(guarded, guarded);
    mutationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
