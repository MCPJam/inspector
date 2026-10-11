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
 * Storage v2 (bottom of this file) holds the compare line-up as a list of
 * SELECTIONS, one per compare card keyed by `comparisonKey`, so two cards of
 * one model at Low and High survive a reload. It is written by a one-time
 * migration of the v1 id array (`migrateSelectedModelsToV2`) and then by the
 * playground; the v1 array is kept (and mirrored) for rollback.
 *
 * `replaceLeadModelId` is the host-switch primitive: it updates both keys
 * atomically and preserves the array's length by rotating an existing
 * entry to the front, or replacing the lead slot in-place, rather than
 * appending. The product rule is "the number of multi-model columns is a
 * workspace preference, not a host property" — switching hosts must swap
 * the lead model in place, never add or remove a column.
 */

import {
  comparisonKey,
  isLegacySelection,
  validateModelSelection,
  type RequestedModelSelection,
} from "@mcpjam/sdk/browser";

const STORAGE_KEY = "mcp-inspector-selected-model";
const MULTI_STORAGE_KEY = "mcp-inspector-selected-models";
const OWN_PROVIDER_STORAGE_KEY = "mcp-inspector-last-own-provider-model";
const LEAD_PROVIDER_HINT_STORAGE_KEY = "mcp-inspector-selected-model-provider";
/**
 * Storage v2 of the compare line-up: a list of SELECTIONS, not model ids.
 * The v1 key (`MULTI_STORAGE_KEY`) is never deleted, and stays mirrored by
 * the playground from the resolved cards, so a rolled-back inspector still
 * reads a sensible id list.
 */
const SELECTIONS_STORAGE_KEY = "mcp-inspector-selected-model-selections.v2";
const EVENT_NAME = "selected-model-changed";
const ARRAY_EVENT_NAME = "selected-model-ids-changed";
const SELECTIONS_EVENT_NAME = "selected-model-selections-changed";

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

/**
 * The last model the user picked from the "Your providers" (BYOK/org-key)
 * side of the picker, remembered separately from the lead selection.
 *
 * The lead key alone can't answer "which own-provider model does this user
 * want?" — it holds whatever is selected right now, which during the
 * free-tier flow is an MCPJam-provided model. Without this memory, the
 * out-of-credits → "bring your own key" hand-off had nothing to restore and
 * fell back to list order, landing on whichever model sorts first
 * (Claude Fable 5) even when the user's key has no access to it. See
 * BACK2-628.
 *
 * Deliberately event-free: nothing subscribes to it, and it is only read at
 * the moment the hand-off runs.
 */
export function loadLastOwnProviderModelId(): string | null {
  try {
    const raw = localStorage.getItem(OWN_PROVIDER_STORAGE_KEY);
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export function saveLastOwnProviderModelId(modelId: string | null): void {
  try {
    const trimmed = modelId?.trim() ?? null;
    if (trimmed && trimmed.length > 0) {
      localStorage.setItem(OWN_PROVIDER_STORAGE_KEY, trimmed);
    } else {
      localStorage.removeItem(OWN_PROVIDER_STORAGE_KEY);
    }
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
 *
 * The v2 selection list is NOT touched here: an id alone cannot say who pays
 * or at which effort. The playground's host seed swaps the lead card there,
 * from the host's own selection (`replaceLeadCompareSelection`).
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

/**
 * Which provider the lead model was picked under, stored as the pair it was
 * picked as.
 *
 * A model id does not name a model on its own. OpenRouter ids share MCPJam's
 * hosted namespace exactly — `anthropic/claude-sonnet-5` is both the hosted
 * row under "Free models" and the row under "Your providers → OpenRouter" —
 * and the lead key stores the id alone. Re-resolving it by id then returned
 * whichever row came first, which is the hosted one: an OpenRouter pick was
 * charged to MCPJam credits and refused with the free-allowance error, on
 * every new chat, reset or restart (#5472).
 *
 * A PAIR, validated against the lead id at read time, rather than a bare
 * provider that has to be cleared whenever the id changes. The lead id has
 * writers that know nothing about providers — the multi-model setter ends in
 * `saveSelectedModelId` too — and a clear-on-write rule would let one of them
 * wipe the hint right after the picker set it. A hint whose id no longer
 * matches is simply ignored, so it cannot go stale.
 *
 * Event-free for the same reason as `loadLastOwnProviderModelId`: the caller
 * keeps it in state alongside the id it qualifies.
 */
export type LeadModelProviderHint = { modelId: string; provider: string };

export function loadLeadModelProviderHint(): LeadModelProviderHint | null {
  try {
    const raw = localStorage.getItem(LEAD_PROVIDER_HINT_STORAGE_KEY);
    if (typeof raw !== "string") return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as LeadModelProviderHint).modelId === "string" &&
      typeof (parsed as LeadModelProviderHint).provider === "string" &&
      (parsed as LeadModelProviderHint).modelId.trim() !== "" &&
      (parsed as LeadModelProviderHint).provider.trim() !== ""
    ) {
      const { modelId, provider } = parsed as LeadModelProviderHint;
      return { modelId, provider };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveLeadModelProviderHint(
  hint: LeadModelProviderHint | null,
): void {
  try {
    if (hint && hint.modelId.trim() !== "" && hint.provider.trim() !== "") {
      localStorage.setItem(
        LEAD_PROVIDER_HINT_STORAGE_KEY,
        JSON.stringify({ modelId: hint.modelId, provider: hint.provider }),
      );
    } else {
      localStorage.removeItem(LEAD_PROVIDER_HINT_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

// ── Storage v2: the compare line-up as selections ─────────────────────────

/** Most compare cards a line-up holds. */
export const MAX_COMPARE_SELECTIONS = 3;

/**
 * Keep only well-formed selections (a validated full selection, or the
 * legacy own-key-only form), one per `comparisonKey` (two cards of one model
 * at Low and High are two entries), at most {@link MAX_COMPARE_SELECTIONS}.
 */
export function normalizeSelectedModelSelections(
  value: unknown,
): RequestedModelSelection[] {
  if (!Array.isArray(value)) return [];
  const out: RequestedModelSelection[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    let selection: RequestedModelSelection | null = null;
    if (isLegacySelection(entry)) {
      const provider = (entry as { provider?: unknown }).provider;
      selection = {
        source: "legacy",
        modelId: entry.modelId.trim(),
        ...(typeof provider === "string" && provider.trim() !== ""
          ? { provider }
          : {}),
      };
    } else {
      const result = validateModelSelection(entry);
      if (result.ok) selection = result.selection;
    }
    if (!selection) continue;
    const key = comparisonKey(selection);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(selection);
    if (out.length >= MAX_COMPARE_SELECTIONS) break;
  }
  return out;
}

/**
 * The v2 line-up, or `null` when v2 was never written (the one-time
 * migration from the v1 id list has not run yet — callers keep reading v1
 * and behave exactly as before).
 */
export function loadSelectedModelSelections():
  RequestedModelSelection[] | null {
  try {
    const raw = localStorage.getItem(SELECTIONS_STORAGE_KEY);
    if (typeof raw !== "string") return null;
    return normalizeSelectedModelSelections(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeSelectedModelSelections(
  selections: readonly RequestedModelSelection[],
): RequestedModelSelection[] {
  const normalized = normalizeSelectedModelSelections(selections);
  try {
    // An empty list is still written: it records that v2 exists, so the
    // migration never re-runs over a v1 list the user has since emptied.
    localStorage.setItem(SELECTIONS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // ignore
  }
  return normalized;
}

/**
 * Persist the v2 line-up. Event-free for the same reason as
 * `saveSelectedModelIds`: in-app writes come from React state that already
 * holds the value, and a same-tab echo would race pending updates.
 */
export function saveSelectedModelSelections(
  selections: readonly RequestedModelSelection[],
): void {
  writeSelectedModelSelections(selections);
}

/**
 * Re-read on outside writes of the v2 line-up: the one-time migration (any
 * instance may run it) and other tabs.
 */
export function subscribeSelectedModelSelections(
  callback: () => void,
): () => void {
  const onCustom = () => callback();
  const onStorage = (event: StorageEvent) => {
    if (event.key === SELECTIONS_STORAGE_KEY) callback();
  };
  window.addEventListener(SELECTIONS_EVENT_NAME, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(SELECTIONS_EVENT_NAME, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

export type SelectedModelsMigrationContext = {
  /**
   * The caller's in-memory v1 id list, when it has one; an empty list falls
   * back to the stored v1 key (React state is still empty on first render).
   */
  v1ModelIds?: readonly string[];
  /**
   * The hosted catalog's load state. Conversion reads the LIVE catalog only:
   * until it is `live` nothing is migrated (the offline snapshot and the
   * last-good cache can both be stale, and a wrong "in catalog" answer would
   * move a card onto MCPJam credits).
   */
  catalogStatus: "loading" | "live" | "fallback";
  /** Model ids of the live hosted catalog. */
  hostedCatalogModelIds: ReadonlySet<string>;
  /**
   * The user's own-key connections (org provider or local key) that serve
   * `modelId` under `provider`, as selections — one per connection. The
   * stored provider hint is honoured only when this names exactly one.
   */
  ownKeySelectionsFor: (
    modelId: string,
    provider: string,
  ) => readonly RequestedModelSelection[];
  /**
   * Whether ANY row for `modelId` under `provider` is listed yet. While the
   * hinted row is missing (an org provider config still loading), the hint
   * cannot be honoured or ruled out, so the migration waits rather than fall
   * through to the catalog check — an OpenRouter id is also a hosted id.
   * Omitted ⇒ always listed.
   */
  isProviderRowListed?: (modelId: string, provider: string) => boolean;
};

/** Fallback a migrated hosted selection carries: refuse, never reroute. */
const MIGRATED_HOSTED_FALLBACK = { provider: "none", model: "none" } as const;

/**
 * Convert one v1 id (Decision 5): the stored provider hint wins when it names
 * exactly one own-key connection; else hosted-catalog membership decides —
 * in the live catalog ⇒ a plain hosted selection, otherwise a stored legacy
 * selection, which means "own key only". Nothing that was on the user's own
 * key is ever moved onto MCPJam credits by this.
 */
function migrateSelectedModelId(
  modelId: string,
  hint: LeadModelProviderHint | null,
  context: SelectedModelsMigrationContext,
): RequestedModelSelection {
  const hinted = hint && hint.modelId === modelId ? hint.provider : undefined;
  if (hinted) {
    const own = context.ownKeySelectionsFor(modelId, hinted);
    if (own.length === 1) return own[0]!;
  }
  if (context.hostedCatalogModelIds.has(modelId)) {
    const hosted = validateModelSelection({
      modelId,
      source: "hosted",
      fallback: MIGRATED_HOSTED_FALLBACK,
    });
    if (hosted.ok) return hosted.selection;
  }
  return {
    source: "legacy",
    modelId,
    ...(hinted ? { provider: hinted } : {}),
  };
}

/**
 * One-time migration of the v1 id list to the v2 selection list.
 *
 *  - v2 already written ⇒ returns it unchanged (never re-migrates);
 *  - nothing in v1 yet ⇒ `null`, nothing written (nothing to convert; the
 *    v1 line-up the surface writes next is migrated then);
 *  - catalog not `live` yet, or the hinted row not listed yet ⇒ returns
 *    `null` and writes nothing: the caller keeps the v1 behaviour until a
 *    later call succeeds;
 *  - otherwise converts each id ({@link migrateSelectedModelId}), writes v2,
 *    notifies subscribers, and leaves the v1 key in place for rollback.
 */
export function migrateSelectedModelsToV2(
  context: SelectedModelsMigrationContext,
): RequestedModelSelection[] | null {
  const existing = loadSelectedModelSelections();
  if (existing) return existing;
  const v1 =
    context.v1ModelIds && context.v1ModelIds.length > 0
      ? [...context.v1ModelIds]
      : loadSelectedModelIds();
  if (v1.length === 0 || context.catalogStatus !== "live") return null;
  const hint = loadLeadModelProviderHint();
  if (
    hint &&
    v1.includes(hint.modelId) &&
    context.isProviderRowListed &&
    !context.isProviderRowListed(hint.modelId, hint.provider)
  ) {
    return null;
  }
  const migrated = writeSelectedModelSelections(
    v1.map((modelId) => migrateSelectedModelId(modelId, hint, context)),
  );
  try {
    window.dispatchEvent(new CustomEvent(SELECTIONS_EVENT_NAME));
  } catch {
    // ignore
  }
  return migrated;
}
