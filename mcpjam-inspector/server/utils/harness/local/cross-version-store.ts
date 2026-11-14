/**
 * Every Inspector version on a machine shares the stores under
 * `~/.mcpjam/harness-local`. Builds that know only Claude Code and Codex read
 * their lists strictly and refuse the whole store over any other harness id,
 * so the authorization and grant stores keep every other runtime's records in
 * a list those builds drop. An entry of that list this build cannot read (a
 * newer build's runtime) is kept as written: never matched, written back, and
 * removed with the member, project, folder or expiry it names, which is all
 * that is read of it.
 */

/** The runtimes the lists every shipped build reads may hold. */
export const SHIPPED_STORE_HARNESS_IDS = ["claude-code", "codex"] as const;

export function readByShippedBuilds(harnessId: string): boolean {
  return (SHIPPED_STORE_HARNESS_IDS as readonly string[]).includes(harnessId);
}

/** The entries of a newer list this build can read, and the rest as written. */
export function splitRuntimeRecords<T>(
  entries: readonly unknown[],
  read: (entry: unknown) => T | undefined,
): { records: T[]; kept: unknown[] } {
  const records: T[] = [];
  const kept: unknown[] = [];
  for (const entry of entries) {
    const record = read(entry);
    if (record === undefined) kept.push(entry);
    else records.push(record);
  }
  return { records, kept };
}

/** One field of a kept entry, read without trusting the rest of it. */
export function keptField(entry: unknown, path: readonly string[]): unknown {
  let value = entry;
  for (const key of path) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
