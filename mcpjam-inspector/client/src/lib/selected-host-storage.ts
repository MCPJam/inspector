/**
 * Storage for the playground's persisted multi-host array — the compare-
 * column line-up of host ids the user wants to compare side-by-side.
 *
 * Per-project scoping: hosts are project entities (a host belongs to a
 * specific project), so the array lives under a project-scoped key
 * `mcp-inspector-selected-hosts:{projectId}`. Switching projects must NOT
 * inherit the previous project's compare-column line-up — opening project
 * B should never surface project A's host ids. This is a deliberate
 * divergence from `selected-model-storage.ts`: models are global
 * resources (the same provider/model ids mean the same thing across
 * projects), so the model array is keyed globally. Hosts are not — so
 * this module project-scopes the array (and the hook project-scopes its
 * sibling `mcp-inspector-multi-host-enabled` toggle for the same reason).
 *
 * This file owns the array key prefix and its same-tab channel
 * (`selected-host-ids-changed`). It does NOT own the lead host id: the
 * LEAD source-of-truth is the per-project "previewed host" managed by
 * `lib/previewed-client-storage.ts` (key: `mcp-previewed-host-id`,
 * project-scoped). `replaceLeadHostId` is the single canonical primitive
 * that promotes a host to the lead position — it writes both the lead key
 * (via `savePreviewedHostId`) AND rotates the array in one atomic
 * operation, then dispatches the array channel once so subscribers see a
 * consistent snapshot.
 *
 * Defensive-derivation contract: `usePersistedHost` (in
 * `hooks/use-persisted-host.ts`) does NOT trust that every lead change
 * flows through `replaceLeadHostId`. Existing UI surfaces (global host
 * bar, project setup flows) call `savePreviewedHostId` directly, which
 * changes the lead without rotating the array. The hook therefore
 * re-applies the same count-preserving algorithm at READ time: if the
 * derived lead is not at slot 0 of the stored array, the hook rotates it
 * to slot 0 (when present elsewhere) or replaces slot 0 (when absent),
 * never growing the array. The invariant is enforced by both writers
 * (`replaceLeadHostId`) and readers (`usePersistedHost`) so an external
 * `savePreviewedHostId` write cannot break column-count preservation.
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
 *     event tick with their own `projectId` to resolve the scoped key.
 *   - Cross-tab `storage` events on any project's array key are forwarded
 *     to subscribers. The listener filters on key PREFIX
 *     (`mcp-inspector-selected-hosts:`) since project-scoping makes the
 *     exact key variable; subscribers re-read with their own projectId.
 *
 * Count-preservation invariant: column count is a workspace preference,
 * not a host property. Switching hosts must swap the lead in place, never
 * grow or shrink the array. `replaceLeadHostId` rotates an existing entry
 * to slot 0 or replaces slot 0 in-place; it never appends or pops. The
 * hook's defensive derivation re-applies the same algorithm at read time.
 */
import { savePreviewedHostId } from "@/lib/previewed-client-storage";

const MULTI_STORAGE_KEY_PREFIX = "mcp-inspector-selected-hosts";
const ARRAY_EVENT_NAME = "selected-host-ids-changed";

function arrayKey(projectId: string): string {
  return `${MULTI_STORAGE_KEY_PREFIX}:${projectId}`;
}

function isArrayKey(key: string | null): boolean {
  if (!key) return false;
  return key.startsWith(`${MULTI_STORAGE_KEY_PREFIX}:`);
}

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

export function loadSelectedHostIds(projectId: string | null): string[] {
  // Defend against null projectId: hosts are per-project, so without a
  // project we have nothing meaningful to return. In practice
  // `PlaygroundTab.tsx` only mounts the hook with a non-null projectId,
  // so this branch is not reachable through the normal app shell — but
  // we still guard the storage seam.
  if (!projectId) return [];
  try {
    const raw = localStorage.getItem(arrayKey(projectId));
    if (typeof raw !== "string" || raw.length === 0) return [];
    const parsed = JSON.parse(raw);
    return normalizeSelectedHostIds(parsed);
  } catch {
    return [];
  }
}

export function saveSelectedHostIds(
  projectId: string | null,
  ids: string[],
): void {
  // No-op when projectId is null: see `loadSelectedHostIds`. Writing
  // without a scope would either leak project A's ids into B's storage
  // or overwrite an existing project's array — both worse than dropping
  // the write.
  if (!projectId) return;
  try {
    const normalized = normalizeSelectedHostIds(ids);
    const key = arrayKey(projectId);
    if (normalized.length > 0) {
      localStorage.setItem(key, JSON.stringify(normalized));
    } else {
      localStorage.removeItem(key);
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
 * rotation, and the hook's defensive derivation handles them).
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

  const current = loadSelectedHostIds(projectId);
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
      const key = arrayKey(projectId);
      if (nextArray.length > 0) {
        localStorage.setItem(key, JSON.stringify(nextArray));
      } else {
        localStorage.removeItem(key);
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
 * only `replaceLeadHostId`) and cross-tab `storage` events on any
 * project-scoped array key. React-side setters intentionally do NOT fire
 * this channel — they update React state directly and call
 * `saveSelectedHostIds` only to mirror localStorage, so subscribers here
 * won't be flooded by every in-app multi-host change.
 *
 * The channel is event-name-keyed (one channel for all projects);
 * subscribers re-read with their own `projectId` to resolve the scoped
 * key. The cross-tab `storage` filter matches the prefix
 * `mcp-inspector-selected-hosts:` so writes to any project's key wake
 * subscribers, who then re-read with their own projectId and ignore
 * irrelevant changes (the re-read for the wrong project simply returns
 * the same value).
 *
 * Lead-host changes flow through `subscribePreviewedHostId` (in
 * `previewed-client-storage.ts`); `usePersistedHost` derives the lead
 * from `usePreviewedHostId`, so subscribers don't need to listen to both
 * channels here — the hook composes them.
 */
export function subscribeSelectedHostIds(callback: () => void): () => void {
  const onCustom = () => callback();
  const onStorage = (event: StorageEvent) => {
    if (isArrayKey(event.key)) callback();
  };
  window.addEventListener(ARRAY_EVENT_NAME, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(ARRAY_EVENT_NAME, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}
