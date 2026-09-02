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
  /** Ends the supervised tree. Supplied by the turn that created the session. */
  stop: () => Promise<void>;
  /** Revokes the lease server-side. Supplied by the turn; best-effort. */
  revokeLease: (() => Promise<void>) | null;
  startedAt: number;
}

const sessions = new Map<string, LocalHarnessSessionRecord>();

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
    await record.stop();
  } catch (error) {
    stopped = false;
    errors.push(`stop: ${messageOf(error)}`);
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
 */
export async function stopAllLocalHarnessSessions(): Promise<{
  ok: boolean;
  stopped: number;
  failed: number;
}> {
  const ids = [...sessions.keys()];
  const results = await Promise.all(
    ids.map((sessionId) =>
      endLocalHarnessSession(sessionId).catch(() => ({
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
