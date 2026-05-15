/**
 * Lead "selected model" id — the single-model picker's choice. Source of
 * truth lives in `localStorage` under `mcp-inspector-selected-model`.
 *
 * Mirrors the pattern in `previewed-host-storage.ts`: same-tab updates
 * propagate via a custom `selected-model-changed` window event so any
 * subscriber (notably `usePersistedModel`) can re-read state when an
 * outside seam writes — e.g. the playground's "snapshot host defaults"
 * helper rewriting the model id when the user picks a different host.
 *
 * Only the lead model is synchronized here. The multi-model array
 * (`mcp-inspector-selected-models`) and the toggle
 * (`mcp-inspector-multi-model-enabled`) remain owned by `usePersistedModel`
 * directly — host changes intentionally don't reset multi-model state.
 */

const STORAGE_KEY = "mcp-inspector-selected-model";
const EVENT_NAME = "selected-model-changed";

interface SelectedModelChangedDetail {
  modelId: string | null;
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
    const detail: SelectedModelChangedDetail = { modelId: next };
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
  } catch {
    // ignore
  }
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
