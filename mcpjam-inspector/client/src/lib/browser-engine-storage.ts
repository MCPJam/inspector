/**
 * The user's Local⇄Cloud browser-engine choice, per project. Each project's
 * choice lives under its OWN localStorage key (`mcp-browser-engine:<projectId>`).
 *
 * Per-key, NOT a shared `{projectId → engine}` map, on purpose: a shared map
 * is read-modify-write, so two tabs setting DIFFERENT projects' engines in the
 * same tick each write back a stale copy and one project's choice is lost.
 * Independent keys can't clobber each other.
 *
 * A DEVICE-scoped preference, deliberately not a project document: the choice
 * is about THIS machine ("run Browser here or in Cloud"), and a
 * teammate opening the same project must never inherit it.
 *
 * Same-tab updates propagate via a custom `browser-engine-changed` window
 * event (both Browser layouts must move together);
 * cross-tab updates come free through the browser `storage` event, now
 * project-precise (a p1 change no longer wakes p2 subscribers).
 */

export type BrowserEngineChoice = "local" | "cloud";

const STORAGE_PREFIX = "mcp-browser-engine:";
const EVENT_NAME = "browser-engine-changed";

interface BrowserEngineChangedDetail {
  projectId: string;
}

function storageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId}`;
}

export function loadBrowserEngine(
  projectId: string,
): BrowserEngineChoice | null {
  try {
    const value = localStorage.getItem(storageKey(projectId));
    return value === "local" || value === "cloud" ? value : null;
  } catch {
    return null;
  }
}

export function saveBrowserEngine(
  projectId: string,
  engine: BrowserEngineChoice | null,
): void {
  try {
    if (engine) {
      localStorage.setItem(storageKey(projectId), engine);
    } else {
      localStorage.removeItem(storageKey(projectId));
    }
    const detail: BrowserEngineChangedDetail = { projectId };
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
  } catch {
    // ignore
  }
}

export function subscribeBrowserEngine(
  projectId: string,
  callback: () => void,
): () => void {
  const key = storageKey(projectId);
  const onCustom = (event: Event) => {
    const detail = (event as CustomEvent<BrowserEngineChangedDetail>).detail;
    if (!detail || detail.projectId === projectId) callback();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === key) callback();
  };
  window.addEventListener(EVENT_NAME, onCustom as EventListener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT_NAME, onCustom as EventListener);
    window.removeEventListener("storage", onStorage);
  };
}
