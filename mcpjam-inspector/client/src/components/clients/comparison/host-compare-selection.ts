const STORAGE_PREFIX = "host-compare-selected:";

export function readHostCompareSelection(projectId: string): string[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(`${STORAGE_PREFIX}${projectId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return null;
  }
}

export function writeHostCompareSelection(
  projectId: string,
  hostIds: ReadonlyArray<string>,
): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(
      `${STORAGE_PREFIX}${projectId}`,
      JSON.stringify([...hostIds]),
    );
  } catch {
    // Ignore quota / private-mode failures.
  }
}

export function reconcileHostCompareSelection(
  hostIds: ReadonlyArray<string>,
  liveHostIds: ReadonlySet<string>,
): string[] {
  return hostIds.filter((id) => liveHostIds.has(id));
}

/** Toggle one host; always keeps at least `minSelected` ids. */
export function toggleHostCompareSelection(
  selectedHostIds: ReadonlyArray<string>,
  hostId: string,
  minSelected = 1,
): string[] {
  const selected = selectedHostIds.includes(hostId);
  if (selected) {
    if (selectedHostIds.length <= minSelected) return [...selectedHostIds];
    return selectedHostIds.filter((id) => id !== hostId);
  }
  return [...selectedHostIds, hostId];
}

export function resolveInitialHostCompareSelection(args: {
  projectId: string;
  liveHostIds: ReadonlyArray<string>;
  previousSelection: ReadonlyArray<string>;
}): string[] {
  const live = new Set(args.liveHostIds);
  if (live.size === 0) return [];

  const stored = readHostCompareSelection(args.projectId);
  if (stored) {
    const fromStorage = reconcileHostCompareSelection(stored, live);
    if (fromStorage.length > 0) return fromStorage;
  }

  const fromPrevious = reconcileHostCompareSelection(args.previousSelection, live);
  if (fromPrevious.length > 0) return fromPrevious;

  return [...args.liveHostIds];
}
