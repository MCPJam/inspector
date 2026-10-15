/**
 * A local harness turn's preparation, confirmed on the key it runs on.
 *
 * On the organization's own key the loopback start refuses (and revokes) a
 * lease that does not confirm the org binding; the turn backstops that here.
 *
 * The lease only names the credential revision once the turn is prepared, and
 * a turn on the organization's key resumes only state produced on the SAME key.
 * A replaced key (or state never produced on an org key) is decided here,
 * before retention or the runtime session is derived from the old state: the
 * preparation is torn down and the turn prepares again under a FRESH session
 * id, so the CLI neither continues the previous account's session nor collides
 * with its retained transcript. A rename keeps the key, the revision and the
 * session.
 */
import { randomUUID } from "node:crypto";
import { logger } from "../../logger.js";
import { stateFromAnotherKey } from "../org-credential-continuity.js";
import type {
  LocalHarnessTurnPreparation,
  PreparedLocalHarnessTurn,
} from "./local-turn.js";

export type LocalOrgKeyPreparation = {
  prepared: PreparedLocalHarnessTurn;
  sessionId: string;
  /** The claimed state was produced on another key; the turn starts fresh. */
  keyReplaced: boolean;
};

/** Tear a preparation the turn will not run on down; a failed stop is logged. */
export function discardLocalPreparation(
  prepared: PreparedLocalHarnessTurn,
): Promise<void> {
  return prepared.teardown().catch((error: unknown) =>
    logger.warn("[harness] local preparation teardown failed", {
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

async function prepareConfirmed(
  prepare: (sessionId: string) => Promise<LocalHarnessTurnPreparation>,
  sessionId: string,
  onOrgKey: boolean,
): Promise<PreparedLocalHarnessTurn> {
  const preparation = await prepare(sessionId);
  if (!preparation.ok) {
    throw new Error(
      `Can't run this turn on your machine (${preparation.status}): ` +
        preparation.message,
    );
  }
  if (onOrgKey && !preparation.prepared.orgUpstream) {
    await discardLocalPreparation(preparation.prepared);
    throw new Error(
      "The model broker did not confirm a lease on the organization's key; the turn was not started.",
    );
  }
  return preparation.prepared;
}

export async function prepareLocalOnOrgKey(args: {
  prepare: (sessionId: string) => Promise<LocalHarnessTurnPreparation>;
  sessionId: string;
  onOrgKey: boolean;
  /** Whether the turn would resume the lane's committed state. */
  resumes: boolean;
  continuity: { state: unknown } | null | undefined;
  /** The revision the claimed state was stamped with, if any. */
  stampedRevision: string | undefined;
  isApprovalResume: boolean;
  /** A run (eval, swarm) owns this session id and cleans up only its state. */
  runOwnsSession: boolean;
}): Promise<LocalOrgKeyPreparation> {
  const prepared = await prepareConfirmed(
    args.prepare,
    args.sessionId,
    args.onOrgKey,
  );
  const leasedRevision = args.onOrgKey
    ? prepared.orgUpstream?.credentialRevision
    : undefined;
  if (
    !leasedRevision ||
    !args.resumes ||
    !args.continuity ||
    !stateFromAnotherKey(args.continuity, args.stampedRevision, leasedRevision)
  ) {
    return { prepared, sessionId: args.sessionId, keyReplaced: false };
  }
  await discardLocalPreparation(prepared);
  if (args.isApprovalResume) {
    throw new Error(
      "The organization's provider key was replaced while the approval was waiting; the pending action will not run. Start a new turn.",
    );
  }
  // A fresh id would outlive the run's cleanup: a key replaced mid-run is a
  // configuration change, and the attempt fails instead.
  if (args.runOwnsSession) {
    throw new Error(
      "The organization's provider key was replaced during this run; the attempt was not continued. Start a new run.",
    );
  }
  const sessionId = `local-${randomUUID()}`;
  return {
    prepared: await prepareConfirmed(args.prepare, sessionId, args.onOrgKey),
    sessionId,
    keyReplaced: true,
  };
}
