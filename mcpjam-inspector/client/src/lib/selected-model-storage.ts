/**
 * Storage for the playground's persisted model selection — both the lead
 * "selected model" id (the single-model picker's choice, under
 * `mcp-inspector-selected-model`) and the multi-model array (the compare-
 * column line-up, under `mcp-inspector-selected-models`).
 *
 * Mirrors the pattern in `previewed-host-storage.ts`: same-tab updates
 * propagate via custom window events so any subscriber (notably
 * `usePersistedModel`) can re-read state when an outside seam writes —
 * e.g. the playground's "snapshot host defaults" helper rewriting the
 * model id when the user picks a different host.
 *
 * There are TWO separate channels:
 *
 *   - `selected-model-changed` — fires on lead-id writes. Subscribers re-
 *     read the lead. This is the only channel that React-side setters
 *     listen to for the lead; the array is React-state-authoritative for
 *     in-app writes.
 *   - `selected-model-ids-changed` — fires ONLY from `replaceLeadModelId`
 *     (the outside-seam primitive). Subscribers re-read the array. We
 *     keep this narrow so that in-app `saveSelectedModelIds` calls (made
 *     as a side effect of React setters) do NOT feed back into React
 *     state — that round-trip caused a regression where, during the
 *     `setSelectedModel`-then-`setSelectedModelIds` sequence emitted by
 *     the model picker, listener-driven value setStates clobbered the
 *     pending longer-array update and the second model never appeared.
 *
 * The multi-model toggle (`mcp-inspector-multi-model-enabled`) is
 * unrelated and stays owned by `usePersistedModel`.
 *
 * `replaceLeadModelId` is the host-switch primitive: it updates both keys
 * atomically and preserves the array's length by rotating an existing
 * entry to the front, or replacing the lead slot in-place, rather than
 * appending. The product rule is "the number of multi-model columns is a
 * workspace preference, not a host property" — switching hosts must swap
 * the lead model in place, never add or remove a column.
 */

const STORAGE_KEY = "mcp-inspector-selected-model";
const MULTI_STORAGE_KEY = "mcp-inspector-selected-models";
const EVENT_NAME = "selected-model-changed";
const ARRAY_EVENT_NAME = "selected-model-ids-changed";

interface SelectedModelChangedDetail {
  modelId: string | null;
}

function normalizeSelectedModelIds(modelIds: unknown): string[] {
  if (!Array.isArray(modelIds)) return [];
  const uniqueModelIds: string[] = [];
  const seen = new Set<string>();
  for (const modelId of modelIds) {
    if (typeof modelId !== "string") continue;
    const trimmed = modelId.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    uniqueModelIds.push(trimmed);
  }
  return uniqueModelIds;
}

function dispatchChanged(modelId: string | null): void {
  try {
    const detail: SelectedModelChangedDetail = { modelId };
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
  } catch {
    // ignore
  }
}

function dispatchArrayChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(ARRAY_EVENT_NAME));
  } catch {
    // ignore
  }
}

export function loadSelectedModelId(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export function saveSelectedModelId(modelId: string | null): void {
  try {
    // Treat whitespace-only ids as null so we don't persist
    // semantically-empty values that would later rehydrate as invalid
    // model picker selections.
    const trimmed = modelId?.trim() ?? null;
    const next = trimmed && trimmed.length > 0 ? trimmed : null;
    if (next) {
      localStorage.setItem(STORAGE_KEY, next);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
    dispatchChanged(next);
  } catch {
    // ignore
  }
}

export function loadSelectedModelIds(): string[] {
  try {
    const raw = localStorage.getItem(MULTI_STORAGE_KEY);
    if (typeof raw !== "string" || raw.length === 0) return [];
    const parsed = JSON.parse(raw);
    return normalizeSelectedModelIds(parsed);
  } catch {
    return [];
  }
}

export function saveSelectedModelIds(ids: string[]): void {
  try {
    const normalized = normalizeSelectedModelIds(ids);
    if (normalized.length > 0) {
      localStorage.setItem(MULTI_STORAGE_KEY, JSON.stringify(normalized));
    } else {
      localStorage.removeItem(MULTI_STORAGE_KEY);
    }
    // Intentionally do NOT dispatch anything here. In-app writes flow
    // from React setters that already updated React state directly — a
    // round-trip through a same-tab event would re-set state to the
    // value we just wrote and, during a `setSelectedModel`-then-
    // `setSelectedModelIds` sequence, race with the pending longer-
    // array update. The host-switch outside seam uses
    // `replaceLeadModelId`, which fires its own `ARRAY_EVENT_NAME` so
    // React-side subscribers still re-read after that write.
  } catch {
    // ignore
  }
}

/**
 * Update the lead model id while preserving the multi-model array's
 * length. Used by the playground's host-snapshot helper when the active
 * host's default lead changes — switching hosts must NOT add or remove a
 * compare column (column count is a workspace preference, not a host
 * property).
 *
 * Semantics:
 *   - `newId` null/whitespace → clear lead, leave array alone (acts like
 *     `saveSelectedModelId(null)`).
 *   - Array currently empty → seed with `[newId]`.
 *   - `newId` already at slot 0 → no array change.
 *   - `newId` at slot k > 0 → rotate to slot 0 (count preserved).
 *   - `newId` not in array → replace slot 0 with `newId` (count preserved).
 *
 * Both the lead key and the array key are written before any event is
 * dispatched, so subscribers re-reading on the event observe a consistent
 * snapshot.
 */
export function replaceLeadModelId(newId: string | null): void {
  const trimmed = newId?.trim() ?? null;
  const next = trimmed && trimmed.length > 0 ? trimmed : null;

  if (!next) {
    // Clear lead, leave the array alone.
    saveSelectedModelId(null);
    return;
  }

  const current = loadSelectedModelIds();
  let nextArray: string[] | null;
  if (current.length === 0) {
    nextArray = [next];
  } else if (current[0] === next) {
    nextArray = null; // no array change
  } else {
    const existingIdx = current.indexOf(next);
    if (existingIdx > 0) {
      // Rotate the existing entry to the front, preserve count.
      const rotated = current.slice();
      rotated.splice(existingIdx, 1);
      rotated.unshift(next);
      nextArray = rotated;
    } else {
      // Replace the lead slot, preserve count.
      nextArray = [next, ...current.slice(1)];
    }
  }

  // Write both keys before any event fires so subscribers see a
  // consistent snapshot. Inline the localStorage writes to avoid the
  // intermediate dispatches that the public `save*` helpers would emit.
  try {
    localStorage.setItem(STORAGE_KEY, next);
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
  // Fire both channels so subscribers re-read whichever they care about.
  // Array event first so observers that read both keys see the lead
  // after the array event, matching the in-tab "write order".
  if (nextArray !== null) {
    dispatchArrayChanged();
  }
  dispatchChanged(next);
}

export function subscribeSelectedModelId(callback: () => void): () => void {
  const onCustom = () => callback();
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) callback();
  };
  window.addEventListener(EVENT_NAME, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT_NAME, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Subscribe to outside-seam writes of the multi-model array (currently
 * only `replaceLeadModelId`). React-side setters intentionally do NOT
 * fire this channel — they update React state directly and call
 * `saveSelectedModelIds` only to mirror localStorage, so subscribers
 * here won't be flooded by every in-app multi-model change.
 *
 * Cross-tab writes still arrive via the `storage` event on the array
 * key, which we also forward to the callback.
 */
export function subscribeSelectedModelIds(callback: () => void): () => void {
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
