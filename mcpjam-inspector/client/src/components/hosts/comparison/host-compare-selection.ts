import { PRESET_HOST_ID_PREFIX } from "./host-compare-presets";

const STORAGE_PREFIX = "host-compare-selected:";

/**
 * Default compare columns when nothing else (URL param, stored preference,
 * prior in-memory selection) picks a selection. Codex and Claude Code are the
 * two most commonly compared coding-agent harnesses, and this default is what
 * makes the caniuse.dev landing (and any other fresh visit to Host Compare)
 * show a meaningful comparison immediately instead of an empty "select a
 * client" state.
 */
export const DEFAULT_COMPARE_HOST_IDS: readonly string[] = [
  `${PRESET_HOST_ID_PREFIX}codex`,
  `${PRESET_HOST_ID_PREFIX}claude-code`,
];

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

export function parseHostsParam(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : null;
}

export function resolveInitialHostCompareSelection(args: {
  projectId: string;
  liveHostIds: ReadonlyArray<string>;
  previousSelection: ReadonlyArray<string>;
  urlSelection?: ReadonlyArray<string> | null;
  /**
   * Every id the user is allowed to select — real live hosts plus synthetic
   * preset host ids. URL / stored / previous selections reconcile against this
   * superset so a preset column survives a reload, while the default fallback
   * stays real-hosts-only (presets are opt-in, never auto-selected). Defaults
   * to `liveHostIds` when omitted (no presets in play).
   */
  knownHostIds?: ReadonlyArray<string>;
}): string[] {
  const known = new Set(args.knownHostIds ?? args.liveHostIds);

  if (args.urlSelection && args.urlSelection.length > 0) {
    const fromUrl = reconcileHostCompareSelection(args.urlSelection, known);
    if (fromUrl.length > 0) return fromUrl;
  }

  const stored = readHostCompareSelection(args.projectId);
  if (stored) {
    const fromStorage = reconcileHostCompareSelection(stored, known);
    if (fromStorage.length > 0) return fromStorage;
  }

  const fromPrevious = reconcileHostCompareSelection(
    args.previousSelection,
    known,
  );
  if (fromPrevious.length > 0) return fromPrevious;

  // Fresh visit, nothing stored: default to Codex + Claude Code rather than
  // "all live hosts" — falls through to live hosts only if the catalog ever
  // stops offering those two preset ids.
  const fromDefaultPresets = reconcileHostCompareSelection(
    DEFAULT_COMPARE_HOST_IDS,
    known,
  );
  if (fromDefaultPresets.length > 0) return fromDefaultPresets;

  return [...args.liveHostIds];
}
