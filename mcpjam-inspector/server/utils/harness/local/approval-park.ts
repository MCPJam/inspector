/**
 * A local session whose turn is paused on a human approval, and whose runtime
 * has to stay ALIVE for that decision to mean anything.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * Claude Code keeps its conversation on disk, so a paused local turn can be
 * torn down and re-driven later. Codex's app-server does not work that way: the
 * pending approval is a JSON-RPC request held open by ONE live `codex
 * app-server` process, inside one thread and one turn, and the bridge in front
 * of it holds the host-tool relay call (and its MCP `tools/call`) that is
 * waiting on the same decision. Tearing the tree down at the pause — which is
 * what a local turn's teardown does — loses the request. The adapter's
 * "Continue." fallback would then re-drive the thread with no approval
 * attached to anything, which is not "continuing what the user approved".
 *
 * So for such a harness the pause PARKS the runtime instead: the process tree,
 * the bridge, the relay state and the gateway's port all stay up; the model
 * credential does not. This module owns that parked state and its exits.
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

export type ParkedSessionState = "awaiting-approval" | "continuing" | "terminal";

export type ParkInvalidationReason =
  | "stopped"
  | "idle-expired"
  | "process-died"
  | "renewal-failed"
  | "authorization-revoked"
  | "continuation-failed"
  | "superseded";

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
  if (entry === undefined) {
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
 * active session once more, and its own teardown owns it.
 */
export function releaseParkedLocalSession(sessionId: string): void {
  const entry = parked.get(sessionId);
  if (entry === undefined) return;
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

function refusal(reason: ClaimRefusal, message: string): {
  ok: false;
  reason: ClaimRefusal;
  message: string;
} {
  return { ok: false, reason, message };
}
