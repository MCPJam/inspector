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
