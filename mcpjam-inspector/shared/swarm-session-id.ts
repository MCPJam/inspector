/**
 * Deterministic swarm (journey-execution) attempt chatSessionId — the ONE
 * implementation shared by the server fan-out runner (claim key + sweep
 * helpers) and the client matrix/deep-link mirror. Both sides MUST mint the
 * exact same id for a given (run, target, sessionIdx) or claims and matrix
 * cells stop lining up.
 *
 * Two id forms (D1, Project Environments):
 *   - LEGACY host target → `synth_<runId>_<hostId>_<sessionIdx>` — byte-identical
 *     to the pre-environments mint, so historical rows and in-flight legacy runs
 *     keep matching.
 *   - ENVIRONMENT target → `synth_<runId>_env_<environmentId>_<sessionIdx>` —
 *     keyed on the FIRST-CLASS `environmentRef.environmentId`, never derived by
 *     parsing the opaque `targetId`. Two environments on the SAME host therefore
 *     mint distinct ids and can never collide within a run.
 */

/** Minimal target identity the mint needs (a structural subset of the pinned
 * execution spec / client target column). `environmentId` comes from the
 * snapshot target's `environmentRef.environmentId` — NEVER from `targetId`. */
export interface SwarmSessionTargetIdentity {
  hostId: string;
  /** Set for environment-based targets only. */
  environmentId?: string | null;
}

export function swarmAttemptChatSessionId(
  runId: string,
  target: SwarmSessionTargetIdentity,
  sessionIndex: number,
): string {
  if (target.environmentId) {
    return `synth_${runId}_env_${target.environmentId}_${sessionIndex}`;
  }
  return `synth_${runId}_${target.hostId}_${sessionIndex}`;
}
