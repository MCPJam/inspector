/**
 * The chat target (client or environment) whose model the user last picked
 * in the Playground. A reload keeps that pick instead of re-applying the
 * client's saved model. Storage is a per-viewer convenience: every access is
 * try/caught and the UI works without it.
 */
const STORAGE_KEY = "mcp-inspector-playground-picked-target";

export function loadPickedTarget(): string | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function savePickedTarget(target: string | null): void {
  try {
    if (target) window.localStorage.setItem(STORAGE_KEY, target);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage is optional.
  }
}
