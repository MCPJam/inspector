/**
 * Who a server-side capture uploads as, and which chat its bytes belong to.
 *
 * Widget HTML, screenshots and replays captured on a user's behalf go through
 * the backend's upload route (`@/shared/blob-upload`, MJ-006) with that
 * user's own Convex bearer — the identity the rest of the run already writes
 * with — scoped to the chat session the evidence is attached to.
 */
export type SnapshotUploadTarget = {
  convexAuthToken: string;
  chatSessionId: string;
  /**
   * Hosted-scenario sessions: the redeemed scenario and its access version,
   * sent with each upload the way the session's own writes send them.
   */
  scenarioId?: string;
  accessVersion?: number;
};

/**
 * The scenario part of an upload's scope for `target`: nothing for a direct
 * session, and an access version only alongside its scenario and only when
 * it is a whole, non-negative number.
 */
export function snapshotScenarioScope(target: SnapshotUploadTarget): {
  scenarioId?: string;
  accessVersion?: number;
} {
  if (!target.scenarioId) return {};
  const { accessVersion } = target;
  return {
    scenarioId: target.scenarioId,
    ...(typeof accessVersion === "number" &&
    Number.isSafeInteger(accessVersion) &&
    accessVersion >= 0
      ? { accessVersion }
      : {}),
  };
}

/**
 * The chat session an eval iteration's evidence belongs to, named the way the
 * backend names the session it writes for that iteration.
 */
export function evalIterationChatSessionId(iterationId: string): string {
  return `eval_${iterationId}`;
}

/**
 * {@link SnapshotUploadTarget} for an eval iteration, or `undefined` when
 * there is no bearer or the iteration never got an id (nothing is persisted
 * for it either).
 */
export function evalSnapshotUploadTarget(
  convexAuthToken: string | undefined,
  iterationId: string | undefined,
): SnapshotUploadTarget | undefined {
  return convexAuthToken && iterationId
    ? {
        convexAuthToken,
        chatSessionId: evalIterationChatSessionId(iterationId),
      }
    : undefined;
}
