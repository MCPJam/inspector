/**
 * Per-model memory of the Playground's reasoning effort.
 *
 * Keyed by the model row's identity (`selectionKey` of its selection, else the
 * picker row key), so the same model on another source is remembered
 * separately and an effort never leaks onto a model that cannot take it.
 * Storage is a per-viewer convenience: every access is try/caught and the UI
 * works without it.
 */
import { MODEL_REASONING_EFFORTS, type ModelReasoningEffort } from "@mcpjam/sdk/browser";

const STORAGE_KEY = "mcp-inspector-reasoning-efforts";

function isEffort(value: unknown): value is ModelReasoningEffort {
  return (
    typeof value === "string" &&
    (MODEL_REASONING_EFFORTS as readonly string[]).includes(value)
  );
}

function readAll(): Record<string, ModelReasoningEffort> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, ModelReasoningEffort> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isEffort(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadRememberedReasoningEffort(
  key: string,
): ModelReasoningEffort | undefined {
  return readAll()[key];
}

/** Remember `effort` for `key`; `undefined` forgets it. */
export function saveRememberedReasoningEffort(
  key: string,
  effort: ModelReasoningEffort | undefined,
): void {
  try {
    const all = readAll();
    if (effort) all[key] = effort;
    else delete all[key];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable: the chip still works for this session.
  }
}
