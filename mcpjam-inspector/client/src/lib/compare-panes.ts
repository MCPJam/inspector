import {
  validateModelSelection,
  type ModelSelection,
} from "@mcpjam/sdk/browser";
import { savePreviewedHostId } from "@/lib/previewed-client-storage";

/**
 * The Playground Compare lineup as panes. A pane is one column: what it runs
 * and the model picked in it.
 *
 * A pane's id is fixed when the pane is created. Reordering, a remount or a
 * later change of target keeps it, so it keys everything the column owns: its
 * card, transcript, readiness, broadcast delivery, App workspace and
 * approvals. A new pane takes its target's id when no other pane holds it, so
 * a saved v1 host list keeps the keys its transcripts and sign-in recovery
 * records already use.
 *
 * Saved per project (`mcp-inspector-compare-panes:{projectId}`), because a
 * client belongs to one project. The lead is not saved here: it is the
 * project's previewed client (`previewed-client-storage.ts`). `syncLeadPane`
 * keeps pane 0 on it when the lineup is read, because some surfaces change the
 * previewed client directly. The lineup never grows or shrinks when only the
 * lead changes: the column count is a workspace preference.
 */
export type ComparePaneTarget =
  | { kind: "host"; hostId: string }
  | { kind: "environment"; environmentId: string };

export interface ComparePane {
  paneId: string;
  target: ComparePaneTarget;
  /** The model picked in this pane. Absent: the pane runs its target's model. */
  pickedSelection?: ModelSelection;
}

export const MAX_COMPARE_PANES = 3;

const STORAGE_PREFIX = "mcp-inspector-compare-panes";
/** The v1 lineup: client ids only. Read once to migrate, never written. */
const V1_STORAGE_PREFIX = "mcp-inspector-selected-hosts";
const CHANGED_EVENT = "compare-panes-changed";

/** The client a pane runs. Null for an environment pane, whose environment names it. */
export function paneHostId(pane: ComparePane): string | null {
  return pane.target.kind === "host" ? pane.target.hostId : null;
}

/** Each client pane's client, in pane order. */
export function paneHostIds(panes: readonly ComparePane[]): string[] {
  return panes.flatMap((pane) => {
    const hostId = paneHostId(pane);
    return hostId ? [hostId] : [];
  });
}

/**
 * A new pane for `target`. Its id is the target's id, or that id with a
 * numbered suffix when a pane in `others` holds it, so the same lineup always
 * gives the same id.
 */
export function createPane(
  target: ComparePaneTarget,
  others: readonly ComparePane[],
): ComparePane {
  const taken = new Set(others.map((pane) => pane.paneId));
  const base = target.kind === "host" ? target.hostId : target.environmentId;
  let paneId = base;
  for (let suffix = 2; taken.has(paneId); suffix += 1) {
    paneId = `${base}~${suffix}`;
  }
  return { paneId, target };
}

function readId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readTarget(value: unknown): ComparePaneTarget | null {
  if (!value || typeof value !== "object") return null;
  const target = value as Record<string, unknown>;
  const hostId = readId(target.hostId);
  if (target.kind === "host" && hostId) return { kind: "host", hostId };
  const environmentId = readId(target.environmentId);
  if (target.kind === "environment" && environmentId) {
    return { kind: "environment", environmentId };
  }
  return null;
}

/**
 * Saved panes as the app can use them: malformed panes and repeated ids are
 * dropped, an invalid picked model is forgotten, and at most three are kept.
 */
export function normalizePanes(value: unknown): ComparePane[] {
  if (!Array.isArray(value)) return [];
  const panes: ComparePane[] = [];
  for (const item of value) {
    if (panes.length === MAX_COMPARE_PANES) break;
    if (!item || typeof item !== "object") continue;
    const pane = item as Record<string, unknown>;
    const paneId = readId(pane.paneId);
    const target = readTarget(pane.target);
    if (!paneId || !target || panes.some((kept) => kept.paneId === paneId)) {
      continue;
    }
    const picked =
      pane.pickedSelection === undefined
        ? null
        : validateModelSelection(pane.pickedSelection);
    panes.push({
      paneId,
      target,
      ...(picked?.ok ? { pickedSelection: picked.selection } : {}),
    });
  }
  return panes;
}

/**
 * The panes for a lineup of client ids, which is how the client chips,
 * first-run setup and sign-in recovery describe it. A client that already has
 * a pane keeps that pane, so its conversation survives; a new client gets a
 * new pane.
 */
export function panesForHostIds(
  current: readonly ComparePane[],
  hostIds: readonly string[],
): ComparePane[] {
  const unmatched = [...current];
  const next: ComparePane[] = [];
  for (const value of hostIds) {
    const hostId = readId(value);
    if (!hostId || next.some((pane) => paneHostId(pane) === hostId)) continue;
    if (next.length === MAX_COMPARE_PANES) break;
    const index = unmatched.findIndex((pane) => paneHostId(pane) === hostId);
    next.push(
      index >= 0
        ? unmatched.splice(index, 1)[0]
        : createPane({ kind: "host", hostId }, [...next, ...unmatched]),
    );
  }
  return next;
}

/**
 * Moves a pane one place left (-1) or right (+1). Moving into or out of pane
 * 0 changes the lead, so the caller restores the lineup with its new lead.
 */
export function movePane<Pane extends ComparePane>(
  panes: readonly Pane[],
  paneId: string,
  offset: -1 | 1,
): readonly Pane[] {
  const from = panes.findIndex((pane) => pane.paneId === paneId);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= panes.length) return panes;
  const next = [...panes];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/**
 * How many clients the client chips may check: three panes in all, less the
 * panes the chips cannot show (environment panes, and a second pane on a
 * client the chips already list).
 */
export function chipClientLimit(panes: readonly ComparePane[]): number {
  const listed = new Set(paneHostIds(panes)).size;
  return MAX_COMPARE_PANES - (panes.length - listed);
}

/**
 * Pane 0 on the lead, with the pane count unchanged: the lead's pane moves to
 * the front, or replaces pane 0 when no pane runs it. An empty lineup reads as
 * the lead alone. Returns `panes` itself when it already agrees.
 */
export function syncLeadPane(
  panes: readonly ComparePane[],
  leadHostId: string | null,
): readonly ComparePane[] {
  if (panes.length === 0) {
    return leadHostId
      ? [createPane({ kind: "host", hostId: leadHostId }, [])]
      : panes;
  }
  if (!leadHostId || paneHostId(panes[0]) === leadHostId) return panes;
  const index = panes.findIndex((pane) => paneHostId(pane) === leadHostId);
  if (index > 0) {
    return [panes[index], ...panes.slice(0, index), ...panes.slice(index + 1)];
  }
  const rest = panes.slice(1);
  return [createPane({ kind: "host", hostId: leadHostId }, rest), ...rest];
}

function storageKey(prefix: string, projectId: string): string {
  return `${prefix}:${projectId}`;
}

/** The project's saved panes. A project with only a v1 list reads it as panes. */
export function loadComparePanes(projectId: string | null): ComparePane[] {
  if (!projectId) return [];
  try {
    const saved = localStorage.getItem(storageKey(STORAGE_PREFIX, projectId));
    if (saved) {
      const record = JSON.parse(saved) as {
        version?: unknown;
        panes?: unknown;
      };
      return record?.version === 2 ? normalizePanes(record.panes) : [];
    }
    const v1: unknown = JSON.parse(
      localStorage.getItem(storageKey(V1_STORAGE_PREFIX, projectId)) ?? "null",
    );
    return Array.isArray(v1) ? panesForHostIds([], v1) : [];
  } catch {
    return [];
  }
}

/**
 * Saves the lineup, an empty one included, and removes the v1 list it
 * replaces, so clearing the lineup never brings an old one back.
 *
 * Dispatches nothing: in-app writers already hold the new state, and an event
 * here would race their pending updates. `promoteLeadPane` is the one writer
 * that tells subscribers.
 */
export function saveComparePanes(
  projectId: string | null,
  panes: readonly ComparePane[],
): void {
  if (!projectId) return;
  try {
    localStorage.setItem(
      storageKey(STORAGE_PREFIX, projectId),
      JSON.stringify({ version: 2, panes: normalizePanes(panes) }),
    );
    localStorage.removeItem(storageKey(V1_STORAGE_PREFIX, projectId));
  } catch {
    // Storage is best effort: this tab's state stays authoritative.
  }
}

/**
 * Makes a client the lead in one write: the previewed client and the pane
 * order change together, then subscribers hear about it once. The lead's pane
 * moves to the front, or replaces pane 0; the count never changes. A null
 * client clears the previewed client and leaves the lineup alone.
 */
export function promoteLeadPane(
  projectId: string,
  hostId: string | null,
): void {
  const lead = readId(hostId);
  if (!lead) {
    savePreviewedHostId(projectId, null);
    return;
  }
  const current = loadComparePanes(projectId);
  const next = syncLeadPane(current, lead);
  if (next !== current) saveComparePanes(projectId, next);
  savePreviewedHostId(projectId, lead);
  if (next === current) return;
  try {
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
  } catch {
    // Subscribers re-read on the next change.
  }
}

/**
 * Hears `promoteLeadPane` in this tab and any lineup write in another tab.
 * Subscribers re-read with their own project id.
 */
export function subscribeComparePanes(callback: () => void): () => void {
  const onChanged = () => callback();
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith(`${STORAGE_PREFIX}:`)) callback();
  };
  window.addEventListener(CHANGED_EVENT, onChanged);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGED_EVENT, onChanged);
    window.removeEventListener("storage", onStorage);
  };
}
