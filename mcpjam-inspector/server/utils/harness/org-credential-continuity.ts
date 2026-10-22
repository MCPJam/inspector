/**
 * Session continuity for harness turns on an ORGANIZATION'S own provider key.
 *
 * A resumed harness session carries opaque provider state from the turns
 * before it (an encrypted reasoning item, a cached prompt prefix). That state
 * belongs to the provider ACCOUNT that produced it, so a session may resume
 * only on the same key: when the organization replaces its key, the next turn
 * starts a fresh runtime session instead of replaying old state into a
 * possibly different account. A rename, which changes nothing about the key,
 * resumes the session.
 *
 * The lease — and with it the credential revision the backend admitted — only
 * exists after the session lane is claimed, so the revision cannot be part of
 * the runtime fingerprint the claim compares. Instead an org turn STAMPS the
 * revision it ran on into the resume state it commits, and the next org turn
 * compares that stamp with its own lease's revision before it creates the
 * runtime session. Hosted turns never stamp, so their state is exactly what
 * the adapter wrote; the fingerprint's credential dimension keeps the two
 * kinds of lane apart.
 */

import { isRecord } from "../byok/list-request.js";

const STAMP_KEY = "mcpjamOrgCredentialRevision";

type StampedResumeState = {
  [STAMP_KEY]: string;
  resumeState: unknown;
};

/** Wrap an org turn's committed resume state with its credential revision. */
export function stampOrgCredentialRevision(
  resumeState: unknown,
  credentialRevision: string,
): StampedResumeState {
  return { [STAMP_KEY]: credentialRevision, resumeState };
}

/**
 * The resume state as the adapter wrote it, and the revision it was stamped
 * with when an org turn committed it. Anything not in the stamped shape is
 * returned as-is with no revision (a hosted lane's state, or one never
 * committed by an org turn).
 */
export function unstampOrgCredentialRevision(resumeState: unknown): {
  resumeState: unknown;
  credentialRevision?: string;
} {
  if (isRecord(resumeState)) {
    const revision = resumeState[STAMP_KEY];
    if (
      Object.keys(resumeState).length === 2 &&
      typeof revision === "string" &&
      "resumeState" in resumeState
    ) {
      return {
        resumeState: resumeState.resumeState,
        credentialRevision: revision,
      };
    }
  }
  return { resumeState };
}

/**
 * Whether a lane's committed state may be resumed by an org turn holding a
 * lease on `credentialRevision`. Only a state stamped with the SAME revision:
 * an unstamped state was never produced on this key.
 */
export function orgResumeAllowed(
  stampedRevision: string | undefined,
  credentialRevision: string,
): boolean {
  return (
    stampedRevision !== undefined && stampedRevision === credentialRevision
  );
}

/**
 * The claimed lane's state as a turn sees it. An org turn strips the stamp, so
 * the adapter only ever sees the state it wrote, and keeps the revision the
 * state was stamped with. A hosted turn's state is unchanged.
 */
export function stateForTurn<S extends { resumeState: unknown }>(
  state: S | null,
  onOrgKey: boolean,
): { state: S | null; credentialRevision?: string } {
  if (!state || !onOrgKey) return { state };
  const unstamped = unstampOrgCredentialRevision(state.resumeState);
  return {
    state: { ...state, resumeState: unstamped.resumeState },
    ...(unstamped.credentialRevision
      ? { credentialRevision: unstamped.credentialRevision }
      : {}),
  };
}

/**
 * Whether a lane holds state an org turn on `leaseRevision` must not resume:
 * state stamped with another revision, or never produced on an org key.
 */
export function stateFromAnotherKey(
  continuity: { state: unknown },
  stampedRevision: string | undefined,
  leaseRevision: string,
): boolean {
  return (
    continuity.state != null &&
    !orgResumeAllowed(stampedRevision, leaseRevision)
  );
}

/**
 * The lane's continuity once its key was replaced: a fresh runtime session,
 * reported as a runtime change when the lane had committed state.
 */
export function resetForReplacedKey<
  C extends { state: unknown; stateVersion: number },
>(continuity: C): C & { state: null; runtimeChanged: boolean } {
  return {
    ...continuity,
    state: null,
    runtimeChanged: continuity.stateVersion > 0,
  };
}

/** The resume state a turn commits: an org turn's carries its lease's revision. */
export function resumeStateToCommit(
  resumeState: unknown,
  orgUpstream: { credentialRevision: string } | undefined,
): unknown {
  return orgUpstream
    ? stampOrgCredentialRevision(resumeState, orgUpstream.credentialRevision)
    : resumeState;
}
