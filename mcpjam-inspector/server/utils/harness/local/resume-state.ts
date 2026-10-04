/** Local teardown proves the bridge stopped. Resume the disk conversation without retrying its dead socket. */
export function localDiskResumeState<T>(state: T): T {
  if (!state || typeof state !== "object") return state;
  const record = state as Record<string, unknown>;
  // Codex's thread lives in its session-data dir (CODEX_HOME rollouts), so a
  // stopped local Codex session resumes from disk the same way: the bridge is
  // respawned and `thread/resume` reads the rollout, rather than retrying a
  // dead socket. An approval continuation (`continue-turn`) is never stripped.
  if ((record.harnessId !== "claude-code" && record.harnessId !== "codex") || record.type !== "resume-session" || !record.data || typeof record.data !== "object") return state;
  const { bridge: _bridge, ...data } = record.data as Record<string, unknown>;
  return { ...record, data } as T;
}

/**
 * The session to resume when the last commit is an unfinished approval turn.
 *
 * A turn that paused for approval is committed as a `continue-turn`. When that
 * turn ends without a fresh commit (Stop while the approved command ran, a
 * continuation that failed, or a new message instead of a decision), the
 * sidecar still holds the continuation. Handing it to `resumeFrom` fails the
 * next turn with "Lifecycle state has unexpected type 'continue-turn';
 * expected 'resume-session'". The conversation itself is intact, so the next
 * turn resumes the SESSION from the same `data` (what HarnessAgent's own
 * stop-mid-turn state carries) and drops the unfinished turn. Its pending
 * approval is void: an action proposed again asks again.
 */
export function sessionResumeStateFrom<T>(state: T): T {
  if (!state || typeof state !== "object") return state;
  const record = state as Record<string, unknown>;
  if (record.type !== "continue-turn") return state;
  return {
    type: "resume-session",
    harnessId: record.harnessId,
    specificationVersion: record.specificationVersion,
    data: record.data,
  } as T;
}
