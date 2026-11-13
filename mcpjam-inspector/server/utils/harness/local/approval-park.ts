/**
 * A local session whose runtime stays ALIVE between two turns: a turn paused
 * on a human approval, or (behind `MCPJAM_LOCAL_KEEP_AGENT`) a Codex runtime
 * kept at the end of an ordinary turn for the conversation's next one.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * Every local runtime holds a pending approval in its live process
 * (`liveApprovalRuntime`): Claude Code's `canUseTool` waits inside the bridge,
 * Codex's app-server holds a JSON-RPC request open inside one thread and one
 * turn, with the host-tool relay call (and its MCP `tools/call`) waiting on
 * the same decision, and GitHub Copilot CLI does the same. Tearing the tree
 * down at the pause — which is what a local turn's teardown does — loses the
 * request. Restarting from the conversation on disk would then re-drive the
 * thread with no approval attached to anything, which is not "continuing
 * what the user approved".
 *
 * So the pause PARKS the runtime instead: the process tree, the bridge, the
 * relay state and the gateway's port all stay up; the model credential does
 * not. This module owns that parked state and its exits.
 *
 * ── Turn parks ───────────────────────────────────────────────────────────
 * A turn park keeps a Codex runtime after a turn that completed and
 * committed, so the next turn can skip starting the CLI. Same registry, same
 * hold (traffic held, lease revoked) and the same exits, plus its own limits:
 * a 15-minute idle TTL, at most four per Inspector (the least recently used
 * idle one is evicted), a 4-hour lifetime, and an end at Inspector shutdown
 * or when an install starts for that harness. It is adopted only by the
 * conversation's next turn, after its lane claim, for the generation and
 * state version that turn's committed state names and the same configuration
 * (`claimLocalTurnPark`); anything else ends it and the turn starts fresh.
 *
 * ── The state machine (D7) ───────────────────────────────────────────────
 *
 *   active ──pause──▶ awaiting-approval ──claim(decision)──▶ continuing
 *     ▲                     │      │                            │
 *     └─────────────────────┼──────┼──────── pause again ◀──────┤
 *                           │      │                            │
 *     terminal ◀── Stop / stop-all / TTL / process death ───────┘
 *                  failed renewal / revoked authorization
 *
 * One owner for cleanup: a parked session is ended ONLY through
 * `endLocalHarnessSession` (the registry), never by a turn's own teardown, so
 * the gateway, the lease and the tree go together exactly once.
 *
 * ── What a decision is bound to ──────────────────────────────────────────
 * A decision is accepted only for the live process GENERATION it was asked in
 * (the bridge token minted when that process started — a restarted bridge has
 * a new one), and only for an approval id that is PENDING in it. Each id is
 * consumed once: a duplicate reply is refused rather than delivered twice, and
 * an id from an earlier pause cannot approve whatever is pending now.
 *
 * ── What it never does ───────────────────────────────────────────────────
 * It never carries a decision across a process death. If the tree, the bridge
 * or this Inspector died, the parked record is gone (or invalid) and the
 * continuation is refused: an explicit new turn may resume the saved history,
 * and any action proposed then needs a fresh approval.
 *
 * Process-local and deliberately not persisted, for the same reason the session
 * registry is not: the runtime it describes dies with this process.
 */
import { logger } from "../../logger.js";

/** How long a parked session waits for a person before it is torn down. */
export const DEFAULT_APPROVAL_PARK_TTL_MS = 30 * 60 * 1000;
/** How long a kept runtime waits for the conversation's next turn. */
export const DEFAULT_TURN_PARK_TTL_MS = 15 * 60 * 1000;
/** The most runtimes one Inspector keeps between turns. */
export const MAX_TURN_PARKS = 4;
/** How long one kept runtime may live, however often it is used. */
export const TURN_PARK_LIFETIME_MS = 4 * 60 * 60 * 1000;

export type ParkedSessionState =
  | "awaiting-approval"
  /** A turn park waiting for the conversation's next turn. */
  | "idle"
  | "continuing"
  | "terminal";

export type ParkInvalidationReason =
  | "stopped"
  | "idle-expired"
  | "process-died"
  | "renewal-failed"
  | "authorization-revoked"
  | "continuation-failed"
  | "superseded"
  | "configuration-changed"
  | "evicted"
  | "lifetime"
  | "shutdown"
  | "runtime-update";

/** What a claim gets back: everything needed to hand the live runtime to the
 *  continuing turn. Opaque to this module. */
export type ParkedResources = unknown;

export interface ParkedLocalSession<R = ParkedResources> {
  sessionId: string;
  /** Identifies the live process generation (the bridge token it started with). */
  generation: string;
  userId: string;
  projectId: string;
  state: ParkedSessionState;
  /** Approval ids the live runtime is waiting on right now. */
  pending: Set<string>;
  /** Every approval id ever decided in this generation. */
  consumed: Set<string>;
  parkedAt: number;
  expiresAt: number;
  resources: R;
  /** Ends the whole session (gateway, lease, tree) through the registry. */
  end: (reason: ParkInvalidationReason) => Promise<void>;
  /** Is the supervised tree still running? Asked at every claim. */
  isAlive: () => boolean;
  /** Stop the gateway forwarding model traffic (park) / resume it. */
  holdModelTraffic: () => void;
  timer: ReturnType<typeof setTimeout> | null;
  invalidatedBy?: ParkInvalidationReason;
  /** Present on a turn park: what the next turn must match to adopt it. */
  kept?: KeptTurn;
}

interface KeptTurn {
  harnessId: string;
  /** The lane state version the turn's commit produced. */
  stateVersion: number;
  /** The configuration the runtime was started with (`kept-runtime.ts`). */
  fingerprint: string;
  /** First kept, for the lifetime; carried across re-parks. */
  createdAt: number;
  /** Last parked or adopted, for eviction. */
  lastUsedAt: number;
}

export type ClaimRefusal =
  | "absent"
  | "terminal"
  | "actor-mismatch"
  | "generation-mismatch"
  | "not-awaiting"
  | "no-decision"
  | "stale-approval"
  | "duplicate-approval"
  | "process-died";

export type ClaimResult<R = ParkedResources> =
  | { ok: true; parked: ParkedLocalSession<R> }
  | { ok: false; reason: ClaimRefusal; message: string };

interface Clock {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimer: (timer) => clearTimeout(timer),
};

let clock: Clock = realClock;
const parked = new Map<string, ParkedLocalSession>();

/** Test seam: a controllable clock, and a clean registry. */
export function resetApprovalParkForTests(testClock?: Partial<Clock>): void {
  for (const entry of parked.values()) {
    if (entry.timer) clock.clearTimer(entry.timer);
  }
  parked.clear();
  clock = { ...realClock, ...testClock };
}

export interface ParkLocalSessionArgs<R> {
  sessionId: string;
  generation: string;
  userId: string;
  projectId: string;
  /** The approvals this pause is waiting on. At least one. */
  pendingApprovalIds: readonly string[];
  resources: R;
  end: (reason: ParkInvalidationReason) => Promise<void>;
  isAlive: () => boolean;
  holdModelTraffic: () => void;
  ttlMs?: number;
}

/**
 * Park a session at an approval pause (active → awaiting-approval), or re-park
 * one whose continuation paused again (continuing → awaiting-approval).
 *
 * Model traffic is held from this moment: nothing may be generated against a
 * credential while nobody is deciding anything. Returns false — and parks
 * nothing — if the session was invalidated in the meantime (a Stop that landed
 * while the turn was winding down), so the caller tears down as usual.
 */
export function parkLocalSession<R>(args: ParkLocalSessionArgs<R>): boolean {
  if (args.pendingApprovalIds.length === 0) {
    throw new Error("a parked session must be waiting on at least one approval");
  }
  const existing = parked.get(args.sessionId);
  if (existing && existing.generation !== args.generation) {
    // A different process now owns this id. The old record (a live one, or
    // the tombstone of one that was stopped or superseded) is not the one
    // waiting; drop it without ending the new one. Checked BEFORE the
    // terminal test: a tombstone of an earlier process must never refuse
    // the current one.
    if (existing.timer) clock.clearTimer(existing.timer);
    parked.delete(args.sessionId);
  } else if (existing?.state === "terminal") {
    // THIS process was stopped while its turn was winding down.
    return false;
  }
  const prior = parked.get(args.sessionId);
  const now = clock.now();
  const ttl = args.ttlMs ?? DEFAULT_APPROVAL_PARK_TTL_MS;
  if (prior?.timer) clock.clearTimer(prior.timer);
  args.holdModelTraffic();
  const entry: ParkedLocalSession<R> = {
    sessionId: args.sessionId,
    generation: args.generation,
    userId: args.userId,
    projectId: args.projectId,
    state: "awaiting-approval",
    pending: new Set(args.pendingApprovalIds),
    // Carried across re-parks: an id decided in an earlier pause of the same
    // process can never be replayed against this one.
    consumed: new Set(prior?.consumed ?? []),
    parkedAt: now,
    expiresAt: now + ttl,
    resources: args.resources,
    end: args.end,
    isAlive: args.isAlive,
    holdModelTraffic: args.holdModelTraffic,
    timer: null,
  };
  for (const id of entry.pending) {
    if (entry.consumed.has(id)) {
      throw new Error(`approval ${id} was already decided in this session`);
    }
  }
  entry.timer = clock.setTimer(() => {
    void invalidateParkedLocalSession(args.sessionId, "idle-expired");
  }, ttl);
  parked.set(args.sessionId, entry as ParkedLocalSession);
  logger.info("[local-harness] session parked awaiting approval", {
    sessionId: args.sessionId,
    pending: entry.pending.size,
    ttlMs: ttl,
  });
  return true;
}

/**
 * Claim a parked session to deliver decisions (awaiting-approval → continuing).
 *
 * Synchronous on purpose: two replies racing for one approval must not both get
 * past the check, and the only way to promise that in this process is to decide
 * before the first `await`. Every refusal says why, so the route can tell a
 * user "already answered" apart from "that session is gone".
 */
export function claimParkedLocalSession<R = ParkedResources>(args: {
  sessionId: string;
  generation: string;
  userId: string;
  projectId: string;
  approvalIds: readonly string[];
}): ClaimResult<R> {
  const entry = parked.get(args.sessionId) as ParkedLocalSession<R> | undefined;
  // A kept runtime holds no approval, so it cannot be the one being answered.
  if (entry === undefined || entry.kept !== undefined) {
    return refusal(
      "absent",
      "The local session holding this approval has ended, so the decision " +
        "cannot be applied. Start a new turn; any action proposed then will " +
        "ask for approval again.",
    );
  }
  if (entry.state === "terminal") {
    return refusal(
      "terminal",
      `The local session holding this approval ended (${entry.invalidatedBy ?? "stopped"}). ` +
        "Start a new turn; any action proposed then will ask for approval again.",
    );
  }
  if (entry.userId !== args.userId || entry.projectId !== args.projectId) {
    return refusal(
      "actor-mismatch",
      "This approval belongs to a different user or project.",
    );
  }
  if (entry.generation !== args.generation) {
    return refusal(
      "generation-mismatch",
      "This approval was asked by an earlier run of the local runtime, which " +
        "has since restarted. It cannot approve anything the new run proposes.",
    );
  }
  if (args.approvalIds.length === 0) {
    return refusal("no-decision", "The continuation carried no approval decision.");
  }
  for (const id of args.approvalIds) {
    if (entry.consumed.has(id)) {
      return refusal(
        "duplicate-approval",
        "This approval was already answered; the action will not run twice.",
      );
    }
  }
  if (entry.state !== "awaiting-approval") {
    return refusal(
      "not-awaiting",
      "This approval is already being continued.",
    );
  }
  for (const id of args.approvalIds) {
    if (!entry.pending.has(id)) {
      return refusal(
        "stale-approval",
        "That decision answers an approval this session is not waiting on.",
      );
    }
  }
  if (!entry.isAlive()) {
    void invalidateParkedLocalSession(args.sessionId, "process-died");
    return refusal(
      "process-died",
      "The local runtime holding this approval stopped. Its pending action " +
        "will not run; start a new turn to continue the conversation.",
    );
  }
  if (entry.timer) clock.clearTimer(entry.timer);
  entry.timer = null;
  entry.state = "continuing";
  for (const id of args.approvalIds) {
    entry.consumed.add(id);
    entry.pending.delete(id);
  }
  return { ok: true, parked: entry };
}

/**
 * The continuation finished without pausing again: the session is an ordinary
 * active session once more, and its own teardown owns it. With `resources`,
 * only a record holding exactly that runtime is released, so a late teardown
 * of one runtime never drops the record of a newer one under the same id.
 */
export function releaseParkedLocalSession(sessionId: string, resources?: unknown): void {
  const entry = parked.get(sessionId);
  if (entry === undefined) return;
  if (resources !== undefined && entry.resources !== resources) return;
  if (entry.timer) clock.clearTimer(entry.timer);
  parked.delete(sessionId);
}

/** How long a terminal record stays to answer a late claim honestly. */
const TOMBSTONE_TTL_MS = 60_000;

/** Drop `entry` after the tombstone window, unless a newer record replaced it. */
function expireTombstone(sessionId: string, entry: ParkedLocalSession): void {
  entry.timer = clock.setTimer(() => {
    if (parked.get(sessionId) === entry) parked.delete(sessionId);
  }, TOMBSTONE_TTL_MS);
}

/**
 * End a parked (or continuing) session for good. Idempotent. Pending decisions
 * become unanswerable at once — synchronously, before any teardown await — and
 * the gateway, the lease and the tree are ended through the registry.
 */
export async function invalidateParkedLocalSession(
  sessionId: string,
  reason: ParkInvalidationReason,
): Promise<void> {
  const entry = parked.get(sessionId);
  if (entry === undefined || entry.state === "terminal") return;
  entry.state = "terminal";
  entry.invalidatedBy = reason;
  entry.pending.clear();
  if (entry.timer) clock.clearTimer(entry.timer);
  entry.timer = null;
  logger.info("[local-harness] parked session ended", { sessionId, reason });
  try {
    await entry.end(reason);
  } catch (error) {
    logger.warn("[local-harness] parked session teardown failed", {
      sessionId,
      reason,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    // Kept as a tombstone only long enough to answer a late claim honestly;
    // dropped when no newer record replaced it.
    if (parked.get(sessionId) === entry) expireTombstone(sessionId, entry);
  }
}

/**
 * Mark a parked session terminal WITHOUT running its teardown, because the
 * registry is already ending it (Stop, stop-all, a workspace or project stop).
 */
export function noteParkedLocalSessionEnded(sessionId: string): void {
  const entry = parked.get(sessionId);
  if (entry === undefined || entry.state === "terminal") return;
  entry.state = "terminal";
  entry.invalidatedBy = "stopped";
  entry.pending.clear();
  if (entry.timer) clock.clearTimer(entry.timer);
  // The same tombstone window as an invalidation, so a Stop never leaves a
  // record behind for good.
  expireTombstone(sessionId, entry);
}

/** For a reconnecting UI and the status route: what is this session waiting on? */
export function describeParkedLocalSession(sessionId: string):
  | {
      state: ParkedSessionState;
      pendingApprovalIds: string[];
      expiresAt: number;
      invalidatedBy?: ParkInvalidationReason;
    }
  | null {
  const entry = parked.get(sessionId);
  if (entry === undefined) return null;
  if (entry.state === "awaiting-approval" && !entry.isAlive()) {
    void invalidateParkedLocalSession(sessionId, "process-died");
  }
  return {
    state: entry.state,
    pendingApprovalIds: [...entry.pending],
    expiresAt: entry.expiresAt,
    ...(entry.invalidatedBy ? { invalidatedBy: entry.invalidatedBy } : {}),
  };
}

/** Is a live (non-terminal) parked record held for this session? */
export function hasParkedLocalSession(sessionId: string): boolean {
  const entry = parked.get(sessionId);
  return entry !== undefined && entry.state !== "terminal";
}

// ── Turn parks ────────────────────────────────────────────────────────────

export interface ParkLocalTurnArgs<R> {
  sessionId: string;
  /** The live process generation: the bridge token in the committed state. */
  generation: string;
  userId: string;
  projectId: string;
  harnessId: string;
  /** The lane state version the turn's commit produces. */
  stateVersion: number;
  /** The configuration the runtime runs with (`kept-runtime.ts`). */
  fingerprint: string;
  resources: R;
  end: (reason: ParkInvalidationReason) => Promise<void>;
  isAlive: () => boolean;
  holdModelTraffic: () => void;
  ttlMs?: number;
}

/**
 * Keep a runtime after a turn that completed (active or continuing → idle).
 *
 * Model traffic is held and the lease revoked from this moment, exactly as
 * for an approval. Returns false, keeping nothing, when the session was
 * stopped while its turn wound down, when the runtime has outlived its
 * lifetime, or when every slot is held by a turn in progress; the caller then
 * tears down as usual.
 */
export function parkLocalTurn<R>(args: ParkLocalTurnArgs<R>): boolean {
  const existing = parked.get(args.sessionId);
  if (existing && existing.generation !== args.generation) {
    // Another process now owns this id; see `parkLocalSession`.
    if (existing.timer) clock.clearTimer(existing.timer);
    parked.delete(args.sessionId);
  } else if (existing?.state === "terminal") {
    return false;
  }
  const prior = parked.get(args.sessionId);
  const now = clock.now();
  const createdAt = prior?.kept?.createdAt ?? now;
  const endOfLife = createdAt + TURN_PARK_LIFETIME_MS;
  if (now >= endOfLife) {
    logger.info("[local-harness] kept runtime reached its lifetime", {
      sessionId: args.sessionId,
    });
    return false;
  }
  if (prior?.kept === undefined && !makeRoomForTurnPark()) return false;
  if (prior?.timer) clock.clearTimer(prior.timer);
  args.holdModelTraffic();
  const idleUntil = now + (args.ttlMs ?? DEFAULT_TURN_PARK_TTL_MS);
  const expiresAt = Math.min(idleUntil, endOfLife);
  const entry: ParkedLocalSession<R> = {
    sessionId: args.sessionId,
    generation: args.generation,
    userId: args.userId,
    projectId: args.projectId,
    state: "idle",
    pending: new Set(),
    consumed: new Set(prior?.consumed ?? []),
    parkedAt: now,
    expiresAt,
    resources: args.resources,
    end: args.end,
    isAlive: args.isAlive,
    holdModelTraffic: args.holdModelTraffic,
    timer: null,
    kept: {
      harnessId: args.harnessId,
      stateVersion: args.stateVersion,
      fingerprint: args.fingerprint,
      createdAt,
      lastUsedAt: now,
    },
  };
  const reason: ParkInvalidationReason = endOfLife <= idleUntil ? "lifetime" : "idle-expired";
  entry.timer = clock.setTimer(() => {
    void invalidateParkedLocalSession(args.sessionId, reason);
  }, expiresAt - now);
  parked.set(args.sessionId, entry as ParkedLocalSession);
  logger.info("[local-harness] runtime kept for the next turn", {
    sessionId: args.sessionId,
    ttlMs: expiresAt - now,
  });
  return true;
}

/**
 * Free a slot for one more kept runtime by evicting the least recently used
 * idle ones. A runtime a turn is using is never evicted; when every slot is
 * such a turn, nothing more is kept.
 */
function makeRoomForTurnPark(): boolean {
  const kept = [...parked.values()].filter(
    (entry) => entry.kept !== undefined && entry.state !== "terminal",
  );
  let held = kept.length;
  const idle = kept
    .filter((entry) => entry.state === "idle")
    .sort((a, b) => (a.kept?.lastUsedAt ?? 0) - (b.kept?.lastUsedAt ?? 0));
  for (const entry of idle) {
    if (held < MAX_TURN_PARKS) break;
    void invalidateParkedLocalSession(entry.sessionId, "evicted");
    held -= 1;
  }
  return held < MAX_TURN_PARKS;
}

export type TurnParkRefusal =
  | "absent"
  | "terminal"
  | "not-idle"
  | "actor-mismatch"
  | "stale"
  | "configuration-changed"
  | "lifetime"
  | "process-died";

/**
 * Hand a kept runtime to the conversation's next turn (idle → continuing).
 *
 * Synchronous, like an approval claim. Adopted only for the generation and
 * the state version the turn's committed lane state names: a turn that ran
 * in between, in another Inspector or after this runtime's commit failed,
 * moved one of them on, and its state is not this runtime's. And only for
 * the same configuration. The caller ends a park it was refused.
 */
export function claimLocalTurnPark<R = ParkedResources>(args: {
  sessionId: string;
  generation: string;
  stateVersion: number;
  fingerprint: string;
  userId: string;
  projectId: string;
}): { ok: true; parked: ParkedLocalSession<R> } | { ok: false; reason: TurnParkRefusal } {
  const entry = parked.get(args.sessionId) as ParkedLocalSession<R> | undefined;
  const kept = entry?.kept;
  if (entry === undefined || kept === undefined) return { ok: false, reason: "absent" };
  if (entry.state === "terminal") return { ok: false, reason: "terminal" };
  if (entry.state !== "idle") return { ok: false, reason: "not-idle" };
  if (entry.userId !== args.userId || entry.projectId !== args.projectId) {
    return { ok: false, reason: "actor-mismatch" };
  }
  if (entry.generation !== args.generation || kept.stateVersion !== args.stateVersion) {
    return { ok: false, reason: "stale" };
  }
  if (kept.fingerprint !== args.fingerprint) {
    return { ok: false, reason: "configuration-changed" };
  }
  const now = clock.now();
  if (now - kept.createdAt >= TURN_PARK_LIFETIME_MS) return { ok: false, reason: "lifetime" };
  if (!entry.isAlive()) return { ok: false, reason: "process-died" };
  if (entry.timer) clock.clearTimer(entry.timer);
  entry.timer = null;
  entry.state = "continuing";
  kept.lastUsedAt = now;
  return { ok: true, parked: entry };
}

/** Is a live (non-terminal) kept runtime held for this session? */
export function hasLocalTurnPark(sessionId: string): boolean {
  const entry = parked.get(sessionId);
  return entry?.kept !== undefined && entry.state !== "terminal";
}

/**
 * End kept runtimes, for one harness or all. A runtime a turn is using is
 * left to that turn unless `includeContinuing`: the turn does not keep it
 * again while what ended the others still holds (`local-turn.ts`).
 */
export async function invalidateLocalTurnParks(
  reason: ParkInvalidationReason,
  options: { harnessId?: string; includeContinuing?: boolean } = {},
): Promise<void> {
  const ending = [...parked.values()].filter(
    (entry) =>
      entry.kept !== undefined &&
      (entry.state === "idle" ||
        (options.includeContinuing === true && entry.state === "continuing")) &&
      (options.harnessId === undefined || entry.kept.harnessId === options.harnessId),
  );
  await Promise.all(
    ending.map((entry) => invalidateParkedLocalSession(entry.sessionId, reason)),
  );
}

/**
 * Inspector shutdown: stop every kept runtime now rather than leave its tree
 * running detached until the next boot's janitor. Bounded, because shutdown
 * has its own deadline and a lease revoke is a network call.
 */
export async function shutdownLocalTurnParks(timeoutMs = 10_000): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    invalidateLocalTurnParks("shutdown", { includeContinuing: true }),
    new Promise<void>((resolvePromise) => {
      deadline = setTimeout(resolvePromise, timeoutMs);
      deadline.unref?.();
    }),
  ]);
  if (deadline) clearTimeout(deadline);
}

function refusal(reason: ClaimRefusal, message: string): {
  ok: false;
  reason: ClaimRefusal;
  message: string;
} {
  return { ok: false, reason, message };
}
