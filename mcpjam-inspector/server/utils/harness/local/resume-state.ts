/** Local teardown proves the bridge stopped. Resume the disk conversation without retrying its dead socket. */
export function localDiskResumeState<T>(state: T): T {
  if (!state || typeof state !== "object") return state;
  const record = state as Record<string, unknown>;
  if (record.harnessId !== "claude-code" || record.type !== "resume-session" || !record.data || typeof record.data !== "object") return state;
  const { bridge: _bridge, ...data } = record.data as Record<string, unknown>;
  return { ...record, data } as T;
}
