/**
 * The user's Local⇄Cloud computer-engine choice, per project. Each project's
 * choice lives under its OWN localStorage key (`mcp-computer-engine:<projectId>`).
 *
 * Per-key, NOT a shared `{projectId → engine}` map, on purpose: a shared map
 * is read-modify-write, so two tabs setting DIFFERENT projects' engines in the
 * same tick each write back a stale copy and one project's choice is lost.
 * Independent keys can't clobber each other.
 *
 * A DEVICE-scoped preference, deliberately not a project document: the choice
 * is about THIS machine ("run agent commands here or on my cloud box"), and a
 * teammate opening the same project must never inherit it.
 *
 * Same-tab updates propagate via a custom `computer-engine-changed` window
 * event (the Computer tab and the Playground rail must move together);
 * cross-tab updates come free through the browser `storage` event, now
 * project-precise (a p1 change no longer wakes p2 subscribers).
 */

export type ComputerEngineChoice = "local" | "cloud";

const STORAGE_PREFIX = "mcp-computer-engine:";
const EVENT_NAME = "computer-engine-changed";

interface ComputerEngineChangedDetail {
  projectId: string;
}

function storageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId}`;
}

export function loadComputerEngine(
  projectId: string,
): ComputerEngineChoice | null {
  try {
    const value = localStorage.getItem(storageKey(projectId));
    return value === "local" || value === "cloud" ? value : null;
  } catch {
    return null;
  }
}

export function saveComputerEngine(
  projectId: string,
  engine: ComputerEngineChoice | null,
): void {
  try {
    if (engine) {
      localStorage.setItem(storageKey(projectId), engine);
    } else {
      localStorage.removeItem(storageKey(projectId));
    }
    const detail: ComputerEngineChangedDetail = { projectId };
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
  } catch {
    // ignore
  }
}

export function subscribeComputerEngine(
  projectId: string,
  callback: () => void,
): () => void {
  const key = storageKey(projectId);
  const onCustom = (event: Event) => {
    const detail = (event as CustomEvent<ComputerEngineChangedDetail>).detail;
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
