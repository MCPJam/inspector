/**
 * `LocalHarnessSupervisor` — the ONE process owner for local harness
 * execution.
 *
 * Adapters never call `child_process`. Providers never call `child_process`.
 * Everything that starts a process on the user's machine for a harness turn
 * comes through here, which is what makes the invariants checkable in one
 * place instead of being a convention nobody can audit:
 *
 *   - absolute launcher path, resolved and verified BEFORE consent, never a
 *     spawn-time `PATH` lookup (invariants 2 and 3);
 *   - structured argv through the argv policy, `shell: false`, always
 *     (invariants 2 and 4);
 *   - an allowlisted environment and a synthetic home, never `process.env`;
 *   - a registered owner — nonce plus birth identity — recorded before the
 *     child is allowed to run (invariant 12);
 *   - wall-clock, output-byte, and concurrency ceilings;
 *   - whole-tree termination on every terminal path, graceful then forced,
 *     with `stopped` reported only once the tree is actually gone
 *     (invariant 11).
 *
 * TRUST MODEL: none of this is containment. A supervised child runs as the OS
 * user with that user's authority. The supervisor bounds what Inspector
 * STARTS and guarantees what Inspector can STOP; the vendor's own permission
 * controls and the user's consent are what bound what the agent may do. Native
 * mode must never be labelled sandboxed on the strength of this file.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, chmod } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { logger } from "../../logger.js";
import { assertArgvAllowed } from "./argv-policy.js";
import {
  readProcessBirthIdentity,
  supportsOwnershipProof,
  terminateOwnedProcessGroup,
} from "./process-identity.js";
import {
  forgetProcess,
  mintSupervisorNonce,
  recordProcess,
  reclaimAbandonedProcesses,
  updateLifecycleState,
  type LocalHarnessProcessRecord,
} from "./process-registry.js";

/** Ceilings. Deliberately conservative: a local harness turn that needs more
 *  than this is a turn nobody is supervising. */
export interface SupervisorLimits {
  /** Hard wall-clock ceiling for one process. */
  maxWallClockMs: number;
  /** Bytes retained per stream before output is dropped (draining continues,
   *  so the child never blocks on a full pipe). */
  maxOutputBytesPerStream: number;
  /** Concurrent supervised processes for one session. */
  maxConcurrentProcesses: number;
  /** Grace period between SIGTERM and SIGKILL of the tree. */
  terminationGraceMs: number;
}

export const DEFAULT_SUPERVISOR_LIMITS: SupervisorLimits = {
  maxWallClockMs: 30 * 60_000,
  maxOutputBytesPerStream: 8 * 1024 * 1024,
  maxConcurrentProcesses: 4,
  terminationGraceMs: 5_000,
};

export interface SupervisedSpawnRequest {
  sessionId: string;
  /** Absolute path. Never a bare name — there is no `PATH` lookup here. */
  executable: string;
  args: readonly string[];
  workingDirectory: string;
  env: Record<string, string>;
  /** Identity for the durable record. */
  runtimeId: string;
  workspaceGrantId: string;
  targetKind: "local-native" | "local-isolated";
  sessionStateDir: string;
  abortSignal?: AbortSignal;
  /** Whether this process becomes the session's ROOT (the bridge). Only the
   *  root is written to the durable registry; short-lived helpers are tracked
   *  in memory, because a record we cannot outlive is noise. */
  role: "root" | "helper";
}

export interface SupervisedProcessHandle {
  pid: number;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  wait: () => Promise<{ exitCode: number }>;
  kill: () => Promise<void>;
}

export class SupervisorError extends Error {}

interface LiveProcess {
  child: ChildProcess;
  pid: number;
  birthIdentity: string | null;
  role: "root" | "helper";
  killed: boolean;
}

function bufferedStream(
  maxBytes: number
): {
  stream: ReadableStream<Uint8Array>;
  push: (chunk: Uint8Array) => void;
  close: () => void;
  truncated: () => boolean;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let written = 0;
  let closed = false;
  let truncated = false;
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
    // The consumer may stop reading (an aborted turn). Swallow the cancel so
    // the push path below does not throw into the child's data handler.
    cancel: () => {
      closed = true;
    },
  });
  return {
    stream,
    push: (chunk) => {
      if (closed) return;
      if (written >= maxBytes) {
        truncated = true;
        return;
      }
      const room = maxBytes - written;
      const slice = chunk.byteLength <= room ? chunk : chunk.subarray(0, room);
      if (slice.byteLength < chunk.byteLength) truncated = true;
      written += slice.byteLength;
      try {
        controller.enqueue(slice);
      } catch {
        closed = true;
      }
    },
    close: () => {
      if (closed) return;
      closed = true;
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
    truncated: () => truncated,
  };
}

export class LocalHarnessSupervisor {
  readonly nonce: string;
  private readonly limits: SupervisorLimits;
  private readonly platform: NodeJS.Platform;
  private readonly live = new Map<string, Set<LiveProcess>>();

  constructor(opts?: {
    limits?: Partial<SupervisorLimits>;
    platform?: NodeJS.Platform;
  }) {
    this.nonce = mintSupervisorNonce();
    this.limits = { ...DEFAULT_SUPERVISOR_LIMITS, ...(opts?.limits ?? {}) };
    this.platform = opts?.platform ?? process.platform;
  }

  /**
   * Reclaim trees abandoned by a previous Inspector process. Safe to call at
   * startup and idempotent; records belonging to THIS supervisor are skipped.
   */
  async reclaimOrphans() {
    return reclaimAbandonedProcesses({
      liveNonce: this.nonce,
      graceMs: this.limits.terminationGraceMs,
      platform: this.platform,
    });
  }

  /** Create a directory inside the session's own state, owner-only. */
  async ensureDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700).catch(() => {});
  }

  /**
   * Start a supervised process.
   *
   * Every rejection here is a refusal to start, never a downgrade: a launch
   * that cannot satisfy the invariants does not happen.
   */
  async spawnSupervised(
    request: SupervisedSpawnRequest
  ): Promise<SupervisedProcessHandle> {
    if (!isAbsolute(request.executable)) {
      throw new SupervisorError(
        `refusing to spawn ${JSON.stringify(request.executable)}: the ` +
          `supervisor launches absolute, pre-verified paths only. A bare name ` +
          `would be resolved through a mutable PATH at spawn time, which is ` +
          `not the runtime consent was granted for.`
      );
    }
    if (!isAbsolute(request.workingDirectory)) {
      throw new SupervisorError(
        "refusing to spawn with a relative working directory"
      );
    }
    if (request.role === "root" && !supportsOwnershipProof(this.platform)) {
      throw new SupervisorError(
        `local harness execution is not available on ${this.platform}: this ` +
          `Inspector cannot prove ownership of a process tree here, so it ` +
          `could not guarantee that stopping a session stops everything it ` +
          `started.`
      );
    }
    assertArgvAllowed(request.args);

    const bucket = this.live.get(request.sessionId) ?? new Set<LiveProcess>();
    if (bucket.size >= this.limits.maxConcurrentProcesses) {
      throw new SupervisorError(
        `session ${request.sessionId} already has ` +
          `${bucket.size} supervised processes (ceiling ` +
          `${this.limits.maxConcurrentProcesses})`
      );
    }

    const child = spawn(request.executable, [...request.args], {
      cwd: request.workingDirectory,
      env: request.env,
      stdio: ["ignore", "pipe", "pipe"],
      // POSIX: become a process-group leader so the whole tree can be signalled.
      detached: this.platform !== "win32",
      // Belt and braces — the default is already false, but this is the single
      // most important property in the file and it should be visible here.
      shell: false,
      windowsHide: true,
    });

    // An 'error' event on a ChildProcess with no listener attached is an
    // unhandled error event, which takes the whole Inspector process down —
    // and there are awaits between here and the full wiring below (reading the
    // birth identity, writing the durable record). So a listener goes on
    // synchronously, right after spawn, and hands off to `finish` once that
    // exists. A failed spawn (ENOENT on the launcher) is exactly this path.
    let earlyError: Error | null = null;
    let onProcessError: (error: Error) => void = (error) => {
      earlyError = error;
    };
    child.on("error", (error: Error) => onProcessError(error));

    const pid = child.pid;
    if (pid === undefined) {
      throw new SupervisorError(
        `the ${request.role} process failed to start (no pid was assigned)`
      );
    }

    // Read the birth identity immediately: this is the value that later proves
    // a pid still belongs to us. Reading it after any await would race a fast
    // exit and a pid reuse.
    const birthIdentity = await readProcessBirthIdentity(pid, this.platform);
    if (request.role === "root" && birthIdentity === null) {
      // The process started but we cannot identify it, so we could not
      // guarantee cleanup. Kill what we just made and refuse.
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      throw new SupervisorError(
        "could not read the process birth identity for the harness root; " +
          "refusing to run a tree this Inspector cannot prove it owns"
      );
    }

    const entry: LiveProcess = {
      child,
      pid,
      birthIdentity,
      role: request.role,
      killed: false,
    };
    bucket.add(entry);
    this.live.set(request.sessionId, bucket);

    if (request.role === "root") {
      const record: LocalHarnessProcessRecord = {
        sessionId: request.sessionId,
        supervisorNonce: this.nonce,
        runtimeId: request.runtimeId,
        rootPid: pid,
        processBirthIdentity: birthIdentity!,
        processGroupIdentity: this.platform === "win32" ? undefined : String(pid),
        startedAt: new Date().toISOString(),
        workspaceGrantId: request.workspaceGrantId,
        targetKind: request.targetKind,
        lifecycleState: "starting",
        sessionStateDir: request.sessionStateDir,
      };
      await recordProcess(record);
      await updateLifecycleState(request.sessionId, "running");
    }

    const out = bufferedStream(this.limits.maxOutputBytesPerStream);
    const err = bufferedStream(this.limits.maxOutputBytesPerStream);
    child.stdout?.on("data", (chunk: Buffer) => out.push(new Uint8Array(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => err.push(new Uint8Array(chunk)));

    let settled = false;
    const exited = new Promise<{ exitCode: number }>((resolvePromise) => {
      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(wallClockTimer);
        if (out.truncated() || err.truncated()) {
          logger.warn("[local-harness] output ceiling reached; output dropped", {
            sessionId: request.sessionId,
            pid,
            stdout: out.truncated(),
            stderr: err.truncated(),
          });
        }
        request.abortSignal?.removeEventListener("abort", onAbort);
        bucket.delete(entry);
        out.close();
        err.close();
        resolvePromise({ exitCode: code });
      };
      onProcessError = (error) => {
        logger.warn("[local-harness] supervised process error", {
          sessionId: request.sessionId,
          error: error.message,
        });
        finish(-1);
      };
      if (earlyError !== null) onProcessError(earlyError);
      child.on("close", (code, signal) => {
        // A signalled exit reports 124 — the conventional timeout code — so a
        // caller reading only the exit code still sees a failure rather than a
        // clean zero.
        finish(code ?? (signal ? 124 : 1));
      });
    });

    const killTree = async (): Promise<void> => {
      if (entry.killed) return;
      entry.killed = true;
      if (entry.birthIdentity === null) {
        // Cannot prove ownership (helper on an unsupported platform): signal
        // only the direct child, never a group.
        child.kill("SIGKILL");
        return;
      }
      const outcome = await terminateOwnedProcessGroup({
        pid,
        birthIdentity: entry.birthIdentity,
        graceMs: this.limits.terminationGraceMs,
        platform: this.platform,
      });
      if (outcome.outcome === "escaped") {
        logger.error("[local-harness] process tree survived SIGKILL", {
          sessionId: request.sessionId,
          pid,
        });
      }
    };

    const onAbort = () => {
      void killTree();
    };
    request.abortSignal?.addEventListener("abort", onAbort, { once: true });

    const wallClockTimer = setTimeout(() => {
      logger.warn("[local-harness] wall-clock ceiling reached", {
        sessionId: request.sessionId,
        pid,
      });
      void killTree();
    }, this.limits.maxWallClockMs);
    wallClockTimer.unref?.();

    return {
      pid,
      stdout: out.stream,
      stderr: err.stream,
      wait: async () => {
        const result = await exited;
        return result;
      },
      kill: async () => {
        await killTree();
        await exited;
      },
    };
  }

  /**
   * Stop everything this supervisor started for a session, and only report
   * success once the trees are gone.
   *
   * Idempotent. Called on stop, abort, timeout, lease expiry, and destroy —
   * the lifecycle contract's terminal paths all converge here so none of them
   * can forget a helper.
   */
  async stopSession(
    sessionId: string
  ): Promise<{ stopped: boolean; escaped: number }> {
    const bucket = this.live.get(sessionId);
    await updateLifecycleState(sessionId, "stopping");
    let escaped = 0;
    if (bucket) {
      // In parallel: each termination waits out its own grace period, and a
      // session with a root plus helpers should be bounded by ONE grace
      // period, not by one per process.
      const outcomes = await Promise.all(
        [...bucket].map(async (entry) => {
          if (entry.birthIdentity === null) {
            entry.child.kill("SIGKILL");
            return null;
          }
          return terminateOwnedProcessGroup({
            pid: entry.pid,
            birthIdentity: entry.birthIdentity,
            graceMs: this.limits.terminationGraceMs,
            platform: this.platform,
          });
        })
      );
      escaped = outcomes.filter((o) => o?.outcome === "escaped").length;
      this.live.delete(sessionId);
    }
    if (escaped === 0) {
      await forgetProcess(sessionId);
      return { stopped: true, escaped };
    }
    // Leave the record in place: an escaped tree is exactly what the janitor
    // and an operator need to see.
    await updateLifecycleState(sessionId, "failed");
    return { stopped: false, escaped };
  }

  /** Live supervised process count for a session (tests and diagnostics). */
  liveProcessCount(sessionId: string): number {
    return this.live.get(sessionId)?.size ?? 0;
  }
}
