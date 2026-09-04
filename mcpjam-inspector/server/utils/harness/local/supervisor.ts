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
  listGroupMembers,
  probeProcess,
  probeProcessGroup,
  readProcessGroupId,
  readProcessBirthIdentity,
  supportsOwnershipProof,
  terminateOwnedProcess,
  terminateOwnedProcessGroup,
  type ProcessBirthIdentity,
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
  /**
   * Windows only: the digest-verified Job Object launcher from the resolved
   * runtime (`ResolvedRuntime.jobLauncherPath`). Spawned in FRONT of
   * `executable`, so the process and everything it starts land in a job that
   * dies with the launcher. Ignored on every other platform; required for a
   * win32 root.
   */
  jobLauncherPath?: string;
}

export interface SupervisedProcessHandle {
  pid: number;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  wait: () => Promise<{ exitCode: number }>;
  kill: () => Promise<void>;
}

export class SupervisorError extends Error {}

/**
 * How long a stop waits for an already-dead root's `exit` event.
 *
 * Node delivers it on the next turns of the loop, so this is generous for what
 * it covers and short enough to be invisible: it only ever elapses in full
 * when the event is never coming, and the stop then proceeds exactly as it did
 * before this existed.
 */
const EXIT_SNAPSHOT_GRACE_MS = 250;

interface LiveProcess {
  child: ChildProcess;
  pid: number;
  birthIdentity: string | null;
  role: "root" | "helper";
  killed: boolean;
  /**
   * The direct child has closed, but its detached process group may still
   * contain descendants. Closed entries remain as ownership tombstones until
   * `stopSession` proves the whole group empty.
   */
  exited: boolean;
  /**
   * Members of the root's process group, enumerated with their birth
   * identities at the instant the root exited — the one moment the group id
   * provably still belongs to this tree. A later stop verifies and signals
   * each of them individually, so a bridge that exits on its own no longer
   * strands the vendor CLI it spawned.
   */
  orphanSnapshot: Promise<Array<{
    pid: number;
    identity: ProcessBirthIdentity;
  }> | null> | null;
}

function bufferedStream(maxBytes: number): {
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

  /**
   * How many times each session has been stopped.
   *
   * Bumped SYNCHRONOUSLY when a stop begins. A launch reads it at entry and
   * again before it spawns: a different value means a stop landed while this
   * launch was in flight, so it refuses rather than starting a process the
   * stop could not see and did not report.
   *
   * A COUNTER, not a tombstone. An earlier draft marked the id stopped
   * forever, which also refused every legitimate later launch — including the
   * provider's own bridge retry, whose whole purpose is that a failed first
   * spawn (which stops the session on its way out) can be tried again and be
   * re-checked as a bridge. Only launches that straddle a stop are refused.
   */
  private readonly stopGenerations = new Map<string, number>();

  /**
   * Launches that have reserved a slot but not yet registered a process.
   *
   * The reserved bucket is empty until the child exists, so without this the
   * ceiling is computed from a count that has not caught up yet.
   */
  private readonly pendingLaunches = new Map<string, number>();
  /**
   * This Inspector process's own birth identity, recorded on every process it
   * owns.
   *
   * A nonce says which supervisor created a record; it does NOT say whether
   * that supervisor is still running. Without this, a second Inspector opened
   * alongside the first would see the first's records under a foreign nonce
   * and reclaim them — killing live sessions belonging to a healthy process.
   * The janitor uses pid + birth identity to require that the owner is
   * genuinely gone before it touches anything.
   */
  private supervisorBirthIdentity: ProcessBirthIdentity | null = null;
  private readonly supervisorIdentityReady: Promise<void>;

  constructor(opts?: {
    limits?: Partial<SupervisorLimits>;
    platform?: NodeJS.Platform;
  }) {
    this.nonce = mintSupervisorNonce();
    this.limits = { ...DEFAULT_SUPERVISOR_LIMITS, ...(opts?.limits ?? {}) };
    this.platform = opts?.platform ?? process.platform;
    this.supervisorIdentityReady = readProcessBirthIdentity(
      process.pid,
      this.platform,
    ).then((identity) => {
      this.supervisorBirthIdentity = identity;
    });
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
    request: SupervisedSpawnRequest,
  ): Promise<SupervisedProcessHandle> {
    if (!isAbsolute(request.executable)) {
      throw new SupervisorError(
        `refusing to spawn ${JSON.stringify(request.executable)}: the ` +
          `supervisor launches absolute, pre-verified paths only. A bare name ` +
          `would be resolved through a mutable PATH at spawn time, which is ` +
          `not the runtime consent was granted for.`,
      );
    }
    if (!isAbsolute(request.workingDirectory)) {
      throw new SupervisorError(
        "refusing to spawn with a relative working directory",
      );
    }
    if (request.role === "root" && !supportsOwnershipProof(this.platform)) {
      throw new SupervisorError(
        `local harness execution is not available on ${this.platform}: this ` +
          `Inspector cannot prove ownership of a process tree here, so it ` +
          `could not guarantee that stopping a session stops everything it ` +
          `started.`,
      );
    }
    assertArgvAllowed(request.args);

    // Windows: the verified Job Object launcher goes in front of the process.
    // `supportsOwnershipProof('win32')` only answers true once runtime
    // resolution has verified one, so a root reaching here without a path is
    // a wiring fault rather than a policy outcome — refused all the same,
    // because the alternative is a tree that "stop" cannot reach.
    const jobLauncher =
      this.platform === "win32" ? request.jobLauncherPath : undefined;
    if (this.platform === "win32" && jobLauncher === undefined) {
      if (request.role === "root") {
        throw new SupervisorError(
          "refusing to start a root process on win32 without the verified " +
            "Job Object launcher: without it, stopping the session could not " +
            "be guaranteed to stop everything it started",
        );
      }
    }
    if (jobLauncher !== undefined && !isAbsolute(jobLauncher)) {
      throw new SupervisorError(
        "the Job Object launcher must be an absolute path inside the " +
          "verified runtime pack",
      );
    }

    // Read SYNCHRONOUSLY, before anything can yield: this is the value a stop
    // landing mid-launch will change.
    const stopGenerationAtEntry =
      this.stopGenerations.get(request.sessionId) ?? 0;

    // ── Everything up to and including bucket registration is SYNCHRONOUS ──
    //
    // Two `spawnSupervised` calls for the same session interleave across the
    // awaits below. If the bucket were read here and stored after an await,
    // each call would build its own Set and the second `this.live.set` would
    // drop the first process from supervision entirely — it would keep
    // running, unregistered, and `stopSession` would never see it. So the
    // slot is reserved before anything can yield.
    const bucket = this.live.get(request.sessionId) ?? new Set<LiveProcess>();
    // Pending launches count toward the ceiling as well as registered ones. A
    // reserved bucket is EMPTY until its child is spawned and its entry added,
    // so counting `bucket.size` alone let concurrent launches all see the same
    // "0 of 4" across their awaits and admit more processes than the limit.
    const pending = this.pendingLaunches.get(request.sessionId) ?? 0;
    // An exited direct child does not consume a concurrency slot, but its
    // entry stays in the bucket as the only in-memory ownership handle for
    // descendants that may have outlived it.
    const active = [...bucket].filter((entry) => !entry.exited).length;
    const admitted = active + pending;
    if (admitted >= this.limits.maxConcurrentProcesses) {
      throw new SupervisorError(
        `session ${request.sessionId} already has ` +
          `${admitted} supervised processes (ceiling ` +
          `${this.limits.maxConcurrentProcesses})`,
      );
    }
    this.live.set(request.sessionId, bucket);
    this.pendingLaunches.set(request.sessionId, pending + 1);
    /** Give back the pending slot. Exactly once, on every path out. */
    let pendingReleased = false;
    const releasePending = (): void => {
      if (pendingReleased) return;
      pendingReleased = true;
      const now = (this.pendingLaunches.get(request.sessionId) ?? 1) - 1;
      if (now <= 0) this.pendingLaunches.delete(request.sessionId);
      else this.pendingLaunches.set(request.sessionId, now);
    };

    /** Give the reservation back, so a pre-spawn failure does not leave an
     *  empty bucket counting against the session's ceiling forever. */
    const releaseReservation = (): void => {
      releasePending();
      if (bucket.size === 0 && this.live.get(request.sessionId) === bucket) {
        this.live.delete(request.sessionId);
      }
    };

    // Captured where it is proven non-null, because the field is mutable and
    // the record below is built after several awaits.
    let ownerBirthIdentity: ProcessBirthIdentity | undefined;
    if (request.role === "root") {
      // BEFORE the spawn, not after. Without our own identity the durable
      // record cannot say whether its owner is alive, so the janitor would
      // have to treat it as permanently live and never reclaim it — a tree
      // nobody can ever clean up. Checking afterwards meant the refusal came
      // with a process already running that we then had to abandon, and an
      // abandon whose termination cannot be proven is exactly the outcome
      // this refusal exists to avoid. Refusing here costs nothing: no process
      // has been created yet.
      //
      // But it comes AFTER the reservation above, and that ordering is load-
      // bearing: an await placed before it left `live` with no bucket for this
      // session, so a concurrent `stopSession` saw nothing to stop, reported
      // `stopped: true`, and the launch then went on to spawn a root behind
      // the stop.
      await this.supervisorIdentityReady;
      if (this.supervisorBirthIdentity === null) {
        releaseReservation();
        throw new SupervisorError(
          "this Inspector could not read its own process identity, so a " +
            "supervised root would be recorded without a reclaimable owner; " +
            "refusing to start it",
        );
      }
      ownerBirthIdentity = this.supervisorBirthIdentity;
    }

    // A stop may have landed while the identity read was in flight. The bucket
    // was reserved, so `stopSession` waited for nothing — but it has already
    // decided this session is over, and starting a process now would put a
    // tree behind a stop that has already been reported.
    if (
      (this.stopGenerations.get(request.sessionId) ?? 0) !==
      stopGenerationAtEntry
    ) {
      releaseReservation();
      throw new SupervisorError(
        `session ${request.sessionId} was stopped while this launch was ` +
          `starting; refusing to spawn a process the stop cannot account for`,
      );
    }

    // On Windows the launcher is the process we hold and record: its pid is
    // the root, its birth identity is the one verified before a kill, and its
    // exit — by any route — is what takes the job down.
    const [spawnExecutable, spawnArgs] =
      jobLauncher !== undefined
        ? [jobLauncher, [request.executable, ...request.args]]
        : [request.executable, [...request.args]];
    const child = spawn(spawnExecutable, spawnArgs, {
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

    // Listeners and stream pumps attach synchronously, before the first await.
    //
    // Two reasons, both of which have bitten this code: an 'error' event with
    // no listener is an unhandled error event that takes the whole Inspector
    // process down; and a short-lived child can EXIT during the awaits below,
    // so a `close` listener attached afterwards would never fire and
    // `wait()` would hang forever. The outcome is therefore recorded into a
    // slot that the promise, built later, reads or subscribes to.
    const out = bufferedStream(this.limits.maxOutputBytesPerStream);
    const err = bufferedStream(this.limits.maxOutputBytesPerStream);
    child.stdout?.on("data", (chunk: Buffer) =>
      out.push(new Uint8Array(chunk)),
    );
    // The first bytes of stderr, kept aside for the one error below that most
    // needs them: a root that cannot be identified is usually a root that
    // died at once, and its own last words are the diagnosis. Without this,
    // every early bridge crash on a platform whose identity probe takes a few
    // seconds reads as "could not read the birth identity".
    let stderrHead = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrHead.length < 2048) {
        stderrHead += chunk.toString(
          "utf8",
          0,
          Math.min(chunk.length, 2048 - stderrHead.length),
        );
      }
      err.push(new Uint8Array(chunk));
    });

    let exitResult: { exitCode: number } | null = null;
    let notifyExit: ((result: { exitCode: number }) => void) | null = null;
    let entry!: LiveProcess;
    const recordExit = (exitCode: number) => {
      if (exitResult !== null) return;
      exitResult = { exitCode };
      if (entry !== undefined) entry.exited = true;
      notifyExit?.(exitResult);
    };
    child.on("error", (error: Error) => {
      logger.warn("[local-harness] supervised process error", {
        sessionId: request.sessionId,
        error: error.message,
      });
      recordExit(-1);
    });
    child.on("exit", () => {
      // The group id is only provably ours while the root still owns it. The
      // instant the root leaves, that anchor is gone — so the snapshot is
      // taken here, synchronously with the exit, and not a moment later.
      if (
        request.role === "root" &&
        entry !== undefined &&
        entry.orphanSnapshot === null
      ) {
        entry.orphanSnapshot = listGroupMembers(entry.pid, this.platform).catch(
          () => null,
        );
      }
    });
    child.on("close", (code, signal) => {
      // A signalled exit reports 124 — the conventional timeout code — so a
      // caller reading only the exit code still sees a failure, not a clean 0.
      recordExit(code ?? (signal ? 124 : 1));
    });

    const pid = child.pid;
    if (pid === undefined) {
      // The slot was reserved before the spawn; release it, or an empty bucket
      // stays in `live` forever and counts against the session's ceiling.
      releaseReservation();
      throw new SupervisorError(
        `the ${request.role} process failed to start (no pid was assigned)`,
      );
    }

    entry = {
      child,
      pid,
      birthIdentity: null,
      role: request.role,
      killed: false,
      exited: exitResult !== null,
      orphanSnapshot: null,
    };
    bucket.add(entry);
    // Registered: it is counted by `bucket.size` from here, so the pending
    // slot is handed back rather than double-counted.
    releasePending();

    // ── From here on, failures must not leave a live unsupervised process ──
    const abandon = async (): Promise<void> => {
      // Two cases, and the difference matters.
      //
      // With a PROVEN birth identity we own the group and can take the whole
      // tree — which is what a registry failure needs, since the child has had
      // time to fork. Without one, only the handle we hold is safe to signal:
      // `process.kill(-pid)` would target a GROUP keyed on a pid we have not
      // verified, which is precisely the ownership invariant this supervisor
      // exists to uphold, and unacceptable even on a failure path.
      if (entry.birthIdentity !== null) {
        await terminateOwnedProcessGroup({
          pid,
          birthIdentity: entry.birthIdentity,
          graceMs: this.limits.terminationGraceMs,
          platform: this.platform,
        }).catch(() => undefined);
      } else {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      bucket.delete(entry);
      // Only ours to remove: `stopSession` may have dropped this key and a
      // later spawn may have installed a different Set under the same id.
      // Deleting that one would silently un-supervise live processes.
      if (bucket.size === 0 && this.live.get(request.sessionId) === bucket) {
        this.live.delete(request.sessionId);
      }
    };

    // Read the birth identity immediately: this is the value that later proves
    // a pid still belongs to us. Reading it after any further await would race
    // a fast exit and a pid reuse.
    const probe = await probeProcess(pid, this.platform);
    const birthIdentity = probe.state === "alive" ? probe.identity : null;
    entry.birthIdentity = birthIdentity;
    if (request.role === "root" && birthIdentity === null) {
      // Started, but unidentifiable — we could not guarantee cleanup, so we
      // refuse rather than run a tree we cannot prove we own. Say WHY: "gone"
      // and "could not look" are different failures with different fixes,
      // and a root that exited before it could be identified has usually
      // said something on stderr.
      await abandon();
      const recordedExit = (): { exitCode: number } | null => exitResult;
      const exit = recordedExit();
      const why =
        probe.state === "gone"
          ? "the process had already exited"
          : probe.state === "unknown"
            ? `the probe could not look (${probe.reason})`
            : "the process could not be identified";
      const exited =
        exit !== null ? `exit code ${exit.exitCode}` : "no exit recorded yet";
      const said =
        stderrHead.trim().length > 0
          ? `; stderr: ${JSON.stringify(stderrHead.trim().slice(0, 1024))}`
          : "";
      throw new SupervisorError(
        `could not read the process birth identity for the harness root — ` +
          `${why} (${exited})${said}; refusing to run a tree this Inspector ` +
          `cannot prove it owns`,
      );
    }

    if (request.role === "root") {
      const record: LocalHarnessProcessRecord = {
        sessionId: request.sessionId,
        supervisorNonce: this.nonce,
        supervisorPid: process.pid,
        supervisorBirthIdentity: ownerBirthIdentity,
        runtimeId: request.runtimeId,
        rootPid: pid,
        processBirthIdentity: birthIdentity!,
        processGroupIdentity:
          this.platform === "win32" ? undefined : String(pid),
        startedAt: new Date().toISOString(),
        workspaceGrantId: request.workspaceGrantId,
        targetKind: request.targetKind,
        lifecycleState: "starting",
        sessionStateDir: request.sessionStateDir,
      };
      try {
        await recordProcess(record);
        await updateLifecycleState(request.sessionId, "running");
      } catch (error) {
        // The durable record is what the janitor recovers from. Without it a
        // crash would strand this tree, so a registry failure means the tree
        // does not run at all.
        await abandon();
        throw new SupervisorError(
          `could not record the supervised process for session ` +
            `${request.sessionId}, so it was terminated rather than left ` +
            `running unrecoverably: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const killTree = async (): Promise<void> => {
      if (entry.killed) return;
      entry.killed = true;
      if (entry.birthIdentity === null) {
        // Cannot prove ownership of a group; signal only the handle we hold.
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
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
      if (outcome.outcome === "unknown") {
        logger.warn("[local-harness] tree not proven stopped; will retry", {
          sessionId: request.sessionId,
          pid,
          reason: outcome.reason,
        });
      }
      // The latch means "a kill is in flight, or the tree is settled" — not
      // "a kill was attempted once". `escaped` and `unknown` settle nothing,
      // and leaving it latched is how a descendant gets stranded for the rest
      // of this process's life: the abort listener and the wall-clock timer
      // both funnel through here, and `stopSession` may never come. Reopening
      // it lets the next trigger try again, which matters most for `unknown`,
      // where the answer may simply be that the probe could not look yet.
      //
      // `not-owned` stays latched: retrying cannot help and must not signal.
      if (outcome.outcome === "escaped" || outcome.outcome === "unknown") {
        entry.killed = false;
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

    // Built AFTER the timer and abort listener exist, so the teardown below
    // can reference them without a temporal dead zone. A child that already
    // exited resolves immediately from the recorded slot.
    const exited = new Promise<{ exitCode: number }>((resolvePromise) => {
      if (exitResult !== null) {
        resolvePromise(exitResult);
        return;
      }
      notifyExit = resolvePromise;
    });

    void exited.then(() => {
      clearTimeout(wallClockTimer);
      request.abortSignal?.removeEventListener("abort", onAbort);
      // Do NOT remove the ownership entry merely because the direct child
      // closed. A descendant can remain in the detached process group after
      // its leader exits; dropping this entry would make a later stop forget
      // the durable root record and report success over that live descendant.
      // `stopSession` settles the group and removes only entries proven gone.
      if (out.truncated() || err.truncated()) {
        logger.warn("[local-harness] output ceiling reached; output dropped", {
          sessionId: request.sessionId,
          pid,
          stdout: out.truncated(),
          stderr: err.truncated(),
        });
      }
      out.close();
      err.close();
    });

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
  /**
   * Give an already-dead root's `exit` handler the moment it needs to run.
   *
   * Node delivers `exit` asynchronously. A stop that arrives between the
   * kernel reaping the root and that delivery sees `orphanSnapshot === null`
   * and no live root, so the group is unanchored and correctly refuses to be
   * signalled — leaving descendants running and the session reported
   * `unknown`. Safe, but the tree survives, which is what the snapshot exists
   * to prevent.
   *
   * Bounded and best-effort: if the root is genuinely still alive, there is
   * nothing to wait for and this returns at once; if the event never arrives,
   * the stop proceeds exactly as it did before.
   */
  private async awaitPendingExitSnapshots(
    bucket: Iterable<LiveProcess>,
  ): Promise<void> {
    const pending = [...bucket].filter(
      (entry) =>
        entry.role === "root" &&
        entry.orphanSnapshot === null &&
        entry.child.exitCode === null &&
        entry.child.signalCode === null,
    );
    if (pending.length === 0) return;
    const deadline = Date.now() + EXIT_SNAPSHOT_GRACE_MS;
    while (Date.now() < deadline) {
      const states = await Promise.all(
        pending.map(async (entry) =>
          entry.orphanSnapshot !== null
            ? "settled"
            : (await probeProcess(entry.pid, this.platform)).state,
        ),
      );
      // Waiting only on a root the kernel says is GONE while its snapshot is
      // still absent — that is the whole window. A root still running has an
      // anchor and needs no snapshot; one that could not be probed is not
      // going to be helped by waiting.
      if (!states.includes("gone")) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async stopSession(
    sessionId: string,
  ): Promise<{ stopped: boolean; escaped: number }> {
    // Synchronously, before this method's own awaits: a concurrent launch
    // compares this against the value it read at entry and refuses rather than
    // starting a process behind a stop that has already been decided.
    this.stopGenerations.set(
      sessionId,
      (this.stopGenerations.get(sessionId) ?? 0) + 1,
    );
    const bucket = this.live.get(sessionId);
    await updateLifecycleState(sessionId, "stopping");
    let escaped = 0;
    if (bucket) {
      // In parallel: each termination waits out its own grace period, and a
      // session with a root plus helpers should be bounded by ONE grace
      // period, not by one per process.
      // Before signalling anything: a root that exited MOMENTS ago has not
      // necessarily had its `exit` event delivered yet, and the snapshot is
      // taken in that handler. Stopping into that window found no snapshot,
      // could not anchor the group, and left the vendor CLI running — the
      // exact defect the snapshot exists to close, just through a narrower
      // door. Waiting for the event that is already on its way is enough; the
      // snapshot must still be taken WHILE the root owns the group, so this
      // does not take one here.
      await this.awaitPendingExitSnapshots(bucket);
      const outcomes = await Promise.all(
        [...bucket].map(async (entry) => {
          if (entry.birthIdentity === null) {
            // Only the handle is safe to signal — `kill(-pid)` would target a
            // GROUP keyed on a pid we never verified. But a handle kill reaches
            // the direct child alone, and nothing here can prove its
            // descendants went with it, so this counts as UNPROVEN rather than
            // stopped. Reporting success over it would be the same lie as
            // reporting `graceful` on a probe that could not look.
            entry.child.kill("SIGKILL");
            return {
              entry,
              result: {
                outcome: "unknown" as const,
                reason:
                  "the process was never identified, so only its own " +
                  "handle could be signalled",
              },
            };
          }
          return {
            entry,
            result: await terminateOwnedProcessGroup({
              pid: entry.pid,
              birthIdentity: entry.birthIdentity,
              graceMs: this.limits.terminationGraceMs,
              platform: this.platform,
            }),
          };
        }),
      );
      // Remove only ownership entries whose WHOLE groups are proven gone.
      // `unknown`, `escaped`, and `not-owned` all retain their entry so an
      // operator or a later retry still has the handle; none authorizes a
      // successful stop.
      for (const { entry, result: initialResult } of outcomes) {
        let result = initialResult;
        // A group whose root has exited is UNANCHORED: its group id no longer
        // belongs to a process whose identity we can check, so the group-wide
        // terminate correctly refuses to signal it. That refusal used to end
        // the story, and a 357 MB vendor CLI kept running after every abort.
        //
        // The snapshot taken at the root's exit is the missing anchor. Each
        // member is re-verified against the birth identity recorded then, and
        // signalled individually — so pid reuse in the meantime means a member
        // is skipped, never that somebody else's process is killed.
        if (result.outcome === "unknown" && entry.orphanSnapshot !== null) {
          const members = (await entry.orphanSnapshot) ?? [];
          const settled: Array<{ pid: number; outcome: string }> = [];
          for (const member of members) {
            settled.push({
              pid: member.pid,
              outcome: await terminateOwnedProcess({
                pid: member.pid,
                identity: member.identity,
                graceMs: this.limits.terminationGraceMs,
                platform: this.platform,
              }),
            });
          }
          const after = await probeProcessGroup(entry.pid, this.platform);
          logger.debug("[local-harness] settled an unanchored process group", {
            sessionId,
            members: settled.length,
            outcomes: settled.map((s) => s.outcome),
            groupAfter: after,
          });
          // Only an EMPTY group counts. Anything else keeps the entry, and the
          // session keeps reporting that it did not fully stop.
          if (after === "empty") result = { outcome: "forced" };
        }
        if (
          result.outcome === "already-gone" ||
          result.outcome === "graceful" ||
          result.outcome === "forced"
        ) {
          bucket.delete(entry);
        } else {
          escaped += 1;
        }
      }
      if (bucket.size === 0 && this.live.get(sessionId) === bucket) {
        this.live.delete(sessionId);
      }
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
    const bucket = this.live.get(sessionId);
    if (!bucket) return 0;
    return [...bucket].filter((entry) => !entry.exited).length;
  }

  /**
   * Is `pid` a process this session started, or a descendant of one?
   *
   * The loopback model gateway asks this before serving a connection, so a
   * process that learned the session capability — it reaches the child in its
   * environment and is written to the bridge's start config — still cannot use
   * it unless it is part of this tree.
   *
   * Descendants count, and are matched by process GROUP rather than by walking
   * a parent chain: the vendor CLI is spawned by the bridge, not by us, so it
   * is never in `live`, but the supervisor puts every root in its own group and
   * the CLI inherits it. A platform that cannot report a group id answers
   * `false` for the descendant half and the direct check still holds.
   */
  async ownsPid(sessionId: string, pid: number): Promise<boolean> {
    const bucket = this.live.get(sessionId);
    if (!bucket) return false;
    const roots: number[] = [];
    for (const entry of bucket) {
      if (entry.exited) continue;
      if (entry.pid === pid) return true;
      if (entry.role === "root") roots.push(entry.pid);
    }
    if (roots.length === 0) return false;

    const cached = this.pidGroups.get(pid);
    if (cached !== undefined) return roots.includes(cached);
    const pgid = await readProcessGroupId(pid, this.platform);
    if (pgid === null) return false;
    this.pidGroups.set(pid, pgid);
    return roots.includes(pgid);
  }

  /**
   * Process-group cache for `ownsPid`.
   *
   * A group id does not change for the life of a process, and the gateway asks
   * this on the model hot path — so the probe runs once per pid rather than
   * once per request. Bounded by pruning entries for pids the session no longer
   * has, on stop.
   */
  private readonly pidGroups = new Map<number, number>();
}
