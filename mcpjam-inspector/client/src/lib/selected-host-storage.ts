/**
 * Storage for the playground's persisted multi-host array — the compare-
 * column line-up of host ids the user wants to compare side-by-side. The
 * array lives in global localStorage under `mcp-inspector-selected-hosts`.
 *
 * This file owns the array key and its same-tab channel
 * (`selected-host-ids-changed`). It does NOT own the lead host id: the
 * LEAD source-of-truth is the per-project "previewed host" managed by
 * `lib/previewed-client-storage.ts` (key: `mcp-previewed-host-id`,
 * project-scoped). `replaceLeadHostId` is the single canonical primitive
 * that promotes a host to the lead position — it writes both the lead key
 * (via `savePreviewedHostId`) AND rotates the array in one atomic
 * operation, then dispatches the array channel once so subscribers see a
 * consistent snapshot.
 *
 * `usePersistedHost` (in `hooks/use-persisted-host.ts`) derives the lead
 * from `usePreviewedHostId(projectId)` and exposes
 * `selectedHostIds` always normalized as `[leadId, ...secondaries]`, so
 * the two cannot drift by construction.
 *
 * Same dispatch asymmetry as `selected-model-storage.ts`:
 *   - `saveSelectedHostIds` does NOT dispatch a same-tab event. In-app
 *     React setters call it only to mirror localStorage, and a round-trip
 *     through a same-tab event would race with pending setStates in the
 *     same batch (see the multi-select regression that motivated the
 *     selected-model fix in PR #2171).
 *   - `replaceLeadHostId` DOES dispatch, because it's the outside-seam
 *     write — fired by host-snapshot apply or by the future
 *     `MultiHostPicker` promotion path. Subscribers re-read on the next
 *     event tick.
 *   - Cross-tab `storage` events on the array key are forwarded to
 *     subscribers for free.
 *
 * Count-preservation invariant: column count is a workspace preference,
 * not a host property. Switching hosts must swap the lead in place, never
 * grow or shrink the array. `replaceLeadHostId` rotates an existing entry
 * to slot 0 or replaces slot 0 in-place; it never appends or pops.
 */
import { savePreviewedHostId } from "@/lib/previewed-client-storage";

const MULTI_STORAGE_KEY = "mcp-inspector-selected-hosts";
const ARRAY_EVENT_NAME = "selected-host-ids-changed";

function normalizeSelectedHostIds(hostIds: unknown): string[] {
  if (!Array.isArray(hostIds)) return [];
  const uniqueHostIds: string[] = [];
  const seen = new Set<string>();
  for (const hostId of hostIds) {
    if (typeof hostId !== "string") continue;
    const trimmed = hostId.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    uniqueHostIds.push(trimmed);
  }
  return uniqueHostIds;
}

function dispatchArrayChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(ARRAY_EVENT_NAME));
  } catch {
    // ignore
  }
}

export function loadSelectedHostIds(): string[] {
  try {
    const raw = localStorage.getItem(MULTI_STORAGE_KEY);
    if (typeof raw !== "string" || raw.length === 0) return [];
    const parsed = JSON.parse(raw);
    return normalizeSelectedHostIds(parsed);
  } catch {
    return [];
  }
}

export function saveSelectedHostIds(ids: string[]): void {
  try {
    const normalized = normalizeSelectedHostIds(ids);
    if (normalized.length > 0) {
      localStorage.setItem(MULTI_STORAGE_KEY, JSON.stringify(normalized));
    } else {
      localStorage.removeItem(MULTI_STORAGE_KEY);
    }
    // Intentionally do NOT dispatch the array channel here. In-app writes
    // flow from React setters that already updated React state directly
    // — a round-trip through a same-tab event would re-set state to the
    // value we just wrote and could race with pending setStates in the
    // same batch. The host-switch outside seam uses `replaceLeadHostId`,
    // which fires the channel itself.
  } catch {
    // ignore
  }
}

/**
 * Promote a host to the lead slot. The single canonical primitive that
 * updates both the per-project previewed host key AND the multi-host
 * array in one atomic operation. `MultiHostPicker` and any future
 * host-snapshot apply seam call only this; nothing else writes the
 * previewed host key for the purpose of promotion (single-mode pickers
 * that simply change the previewed host without rotating the array
 * continue to use `savePreviewedHostId` directly — they don't need
 * rotation).
 *
 * Semantics (mirroring `replaceLeadModelId`):
 *   - `newHostId` null/whitespace → clear the lead key, leave array
 *     alone.
 *   - Array currently empty → seed with `[newHostId]`.
 *   - `newHostId` already at slot 0 → no array change.
 *   - `newHostId` at slot k > 0 → rotate to slot 0 (count preserved).
 *   - `newHostId` not in array → replace slot 0 with `newHostId`
 *     (count preserved).
 *
 * Both writes complete before any event is dispatched, so subscribers
 * re-reading on the event observe a consistent snapshot.
 */
export function replaceLeadHostId(
  projectId: string,
  newHostId: string | null,
): void {
  const trimmed = newHostId?.trim() ?? null;
  const next = trimmed && trimmed.length > 0 ? trimmed : null;

  if (!next) {
    // Clear the lead, leave the array alone. Matches `replaceLeadModelId(null)`
    // semantics: clearing the lead is a "no preview" gesture, not a
    // column-count change.
    savePreviewedHostId(projectId, null);
    return;
  }

  const current = loadSelectedHostIds();
  let nextArray: string[] | null;
  if (current.length === 0) {
    nextArray = [next];
  } else if (current[0] === next) {
    nextArray = null; // no array change
  } else {
    const existingIdx = current.indexOf(next);
    if (existingIdx > 0) {
      // Rotate existing entry to the front, preserve count.
      const rotated = current.slice();
      rotated.splice(existingIdx, 1);
      rotated.unshift(next);
      nextArray = rotated;
    } else {
      // Replace the lead slot, preserve count.
      nextArray = [next, ...current.slice(1)];
    }
  }

  // Write the array directly (bypassing `saveSelectedHostIds`) so the
  // single array event we dispatch below sees both the lead key and the
  // array key already up to date. Subscribers that read both keys after
  // the event observe a consistent snapshot.
  try {
    if (nextArray !== null) {
      if (nextArray.length > 0) {
        localStorage.setItem(MULTI_STORAGE_KEY, JSON.stringify(nextArray));
      } else {
        localStorage.removeItem(MULTI_STORAGE_KEY);
      }
    }
  } catch {
    // ignore
  }
  // Lead write goes through `savePreviewedHostId` so cross-surface
  // subscribers (Connect's overlay, the existing previewed-host channel)
  // get notified the same way they always have.
  savePreviewedHostId(projectId, next);
  // Fire the array channel once, AFTER both writes complete.
  if (nextArray !== null) {
    dispatchArrayChanged();
  }
}

/**
 * Subscribe to outside-seam writes of the multi-host array (currently
 * only `replaceLeadHostId`) and cross-tab `storage` events on the array
 * key. React-side setters intentionally do NOT fire this channel — they
 * update React state directly and call `saveSelectedHostIds` only to
 * mirror localStorage, so subscribers here won't be flooded by every
 * in-app multi-host change.
 *
 * Lead-host changes flow through `subscribePreviewedHostId` (in
 * `previewed-client-storage.ts`); `usePersistedHost` derives the lead
 * from `usePreviewedHostId`, so subscribers don't need to listen to both
 * channels here — the hook composes them.
 */
export function subscribeSelectedHostIds(callback: () => void): () => void {
  const onCustom = () => callback();
  const onStorage = (event: StorageEvent) => {
    if (event.key === MULTI_STORAGE_KEY) callback();
  };
  window.addEventListener(ARRAY_EVENT_NAME, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(ARRAY_EVENT_NAME, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}
