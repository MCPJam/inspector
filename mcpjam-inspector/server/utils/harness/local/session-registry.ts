/**
 * The live local-harness sessions this process owns, and the one place that
 * can end all of them.
 *
 * ── Why a registry, on top of the supervisor ─────────────────────────────
 * The supervisor already tracks process trees, and the janitor already reclaims
 * ones orphaned by a crash. Neither knows about the two things that live
 * ALONGSIDE a tree and have to die with it: the loopback gateway holding the
 * session's lease, and the server-side lease itself.
 *
 * So a session is not just a tree. It is a tree, a gateway, and a lease, and
 * "stop this session" has to mean all three or it means nothing — a gateway
 * left listening with a live lease is a credential nobody is watching.
 *
 * The registry is process-local and deliberately not persisted. A crashed
 * Inspector's gateways die with it (they are listeners in this process), and
 * its leases expire on their own TTL and are swept by the backend cron. What
 * survives a crash is the process tree, and the janitor is what reclaims that.
 */
import { logger } from "../../logger.js";
import type { LocalModelGateway } from "./model-gateway.js";

export interface LocalHarnessSessionRecord {
  sessionId: string;
  /** Opaque ids only — this record is read by telemetry and a stop-all route. */
  runtimeId: string;
  workspaceGrantId: string;
  /** The broker run id, for revoking the lease server-side. */
  brokerRunId: string | null;
  gateway: LocalModelGateway | null;
  /**
   * Ends the supervised tree, and says whether it is actually down.
   *
   * `stopped: false` means something escaped. The reservation below is only
   * given up on a proven stop, so this answer has to travel rather than be
   * assumed from "the call did not throw".
   */
  stop: () => Promise<{ stopped: boolean; escaped?: number }>;
  /** Revokes the lease server-side. Supplied by the turn; best-effort. */
  revokeLease: (() => Promise<void>) | null;
  /**
   * Gives up this session's claim on the runtime version directory.
   *
   * Supplied by the turn, and idempotent, because two paths end a session and
   * both have to release it: the turn's own teardown and this module's
   * `endLocalHarnessSession` (the stop-all button). Only ever called AFTER
   * `stop`, since the reservation is what stops another process replacing the
   * tree these children are executing from — and they are provably gone only
   * once `stop` has run.
   */
  releaseRuntime: (() => Promise<void>) | null;
  startedAt: number;
}

const sessions = new Map<string, LocalHarnessSessionRecord>();

/**
 * Sessions whose tree would not stop.
 *
 * The map above holds ONE record per session id, which is the right shape for
 * live sessions and the wrong shape for this: a tree that escaped its stop is
 * still running, still holds its runtime reservation, and still needs a handle
 * — but the id it was registered under may since have been taken by a newer
 * turn. Re-registering it over that newer record would put a live session
 * beyond `stop-all`'s reach, and declining to re-register lost the escaped tree
 * instead. Both are the same harm in opposite directions, and both came from
 * trying to express two live trees in one map slot.
 *
 * So they are kept here as well, by record. `stop-all` drains this on top of
 * the map, which is what makes its docstring true — every session this process
 * owns, including the ones a previous stop could not prove down.
 */
const unstopped = new Set<LocalHarnessSessionRecord>();

export function registerLocalHarnessSession(
  record: LocalHarnessSessionRecord,
): void {
  sessions.set(record.sessionId, record);
}

export function getLocalHarnessSession(
  sessionId: string,
): LocalHarnessSessionRecord | undefined {
  return sessions.get(sessionId);
}

export function forgetLocalHarnessSession(sessionId: string): void {
  sessions.delete(sessionId);
  for (const record of unstopped) {
    if (record.sessionId === sessionId) unstopped.delete(record);
  }
}

/**
 * Drop a session, but only if THIS record is still the one registered.
 *
 * By id alone, a teardown that finishes late removes whatever is under that id
 * now — including a live session a later turn registered while the old tree was
 * still inside its SIGTERM grace, which would put a running session beyond the
 * reach of `stop-all`. The turn's teardown gives up the runtime reservation on
 * a proven stop either way; it is the map entry that has to belong to it.
 *
 * Unreachable through `run-harness-turn.ts` today, which mints
 * `local-<uuid>` per turn — but that invariant lives in another file, and the
 * cost of not depending on it is this comparison.
 */
export function forgetLocalHarnessSessionRecord(
  record: LocalHarnessSessionRecord,
): boolean {
  unstopped.delete(record);
  if (sessions.get(record.sessionId) !== record) return false;
  sessions.delete(record.sessionId);
  return true;
}

export function listLocalHarnessSessions(): LocalHarnessSessionRecord[] {
  return [...sessions.values()];
}

/**
 * End one session completely: revoke the gateway, revoke the lease, stop the
 * tree.
 *
 * The gateway is revoked FIRST and synchronously, because it is the only step
 * that takes effect immediately and locally. Revoking the lease is a network
 * call that can fail, and stopping a tree takes as long as a SIGTERM grace —
 * during both of those the child must already be unable to spend anything.
 *
 * Every step is attempted even if an earlier one throws, because a failure to
 * revoke a lease is not a reason to leave a process tree running.
 */
export async function endLocalHarnessSession(
  sessionId: string,
): Promise<{ stopped: boolean; errors: string[] }> {
  const record = sessions.get(sessionId);
  if (record === undefined) return { stopped: true, errors: [] };
  sessions.delete(sessionId);
  return endRecord(record);
}

/**
 * The teardown itself, on a record already taken out of the map.
 *
 * Split out so `stop-all` can run it over escaped records too — those have no
 * map entry to look up, and re-deriving one by id is exactly the confusion this
 * module keeps paying for.
 */
async function endRecord(
  record: LocalHarnessSessionRecord,
): Promise<{ stopped: boolean; errors: string[] }> {
  const sessionId = record.sessionId;
  const errors: string[] = [];

  try {
    record.gateway?.revoke();
  } catch (error) {
    errors.push(`gateway revoke: ${messageOf(error)}`);
  }
  try {
    await record.gateway?.close();
  } catch (error) {
    errors.push(`gateway close: ${messageOf(error)}`);
  }
  try {
    await record.revokeLease?.();
  } catch (error) {
    errors.push(`lease revoke: ${messageOf(error)}`);
  }
  let stopped = true;
  try {
    const outcome = await record.stop();
    // A resolved call is not a stopped tree. `stopSession` reports escaped
    // children in its RESULT, and reading only the absence of a throw counted
    // those as a clean stop.
    //
    // Anything that is not an explicit `stopped: true` counts as not stopped.
    // The type used to permit `void` — widened to fit a test fixture, which is
    // the wrong direction for a contract — and `undefined` then slipped past
    // this check as a success, releasing the reservation on the exact evidence
    // the check exists to demand.
    if (outcome?.stopped !== true) {
      stopped = false;
      errors.push(
        `stop: ${outcome?.escaped ?? "some"} process(es) escaped the session`,
      );
    }
  } catch (error) {
    stopped = false;
    errors.push(`stop: ${messageOf(error)}`);
  }
  // AFTER the stop, and only if it worked. Ending a session here used to leave
  // the runtime reservation held for the life of the process, so the stop-all
  // button freed every session and still blocked the next reinstall or repair.
  // But giving it up while something escaped is the worse failure: the
  // reservation is what stops `activateVerifiedPack` replacing the directory
  // those children are still executing from.
  if (stopped) {
    unstopped.delete(record);
    try {
      await record.releaseRuntime?.();
    } catch (error) {
      errors.push(`runtime release: ${messageOf(error)}`);
    }
  } else {
    // Kept. The record is taken out of the map up front so two concurrent
    // callers cannot both run this teardown, but dropping it PERMANENTLY on a
    // failed stop threw away the only handle this process had on a tree that is
    // still running — and with it the reservation that tree still holds, which
    // is what blocks the next reinstall or repair.
    //
    // Held by RECORD rather than by map slot, because the slot may belong to a
    // newer turn by now and only one of them can have it. `stop-all` reads both.
    unstopped.add(record);
    // And listed by id as well when nothing newer claims it, so the ordinary
    // lookups — `stop-all`'s own pass, the telemetry count — see it where they
    // already look.
    if (!sessions.has(sessionId)) sessions.set(sessionId, record);
  }
  if (errors.length > 0) {
    logger.warn("[local-harness] session teardown had failures", {
      sessionId,
      errors,
    });
  }
  return { stopped, errors };
}

/**
 * The local brake: end every session this process owns.
 *
 * Sessions are ended in parallel — one that hangs on a SIGTERM grace must not
 * delay the rest, and the whole point of the button is that it acts now.
 *
 * "Every session" includes the ones a previous stop could not prove down. They
 * are the reason the button gets pressed a second time, and reading only the
 * map meant the second press did nothing for exactly the tree that needed it.
 */
export async function stopAllLocalHarnessSessions(): Promise<{
  ok: boolean;
  stopped: number;
  failed: number;
}> {
  // Taken out of the map up front, so a record re-added by its own failed
  // teardown is not immediately picked up and sent a second SIGTERM by this
  // same pass.
  const live = [...sessions.values()];
  for (const record of live) sessions.delete(record.sessionId);
  const escaped = [...unstopped].filter((record) => !live.includes(record));
  const results = await Promise.all(
    [...live, ...escaped].map((record) =>
      endRecord(record).catch(() => ({
        stopped: false,
        errors: ["unexpected"],
      })),
    ),
  );
  const failed = results.filter((result) => !result.stopped).length;
  return { ok: failed === 0, stopped: results.length - failed, failed };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
