/**
 * The user's Local⇄Cloud computer-engine choice, per project. Source of truth
 * lives in `localStorage` under `mcp-computer-engine` (an object keyed by
 * `projectId` → `"local" | "cloud"`).
 *
 * A DEVICE-scoped preference, deliberately not a project document: the choice
 * is about THIS machine ("run agent commands here or on my cloud box"), and a
 * teammate opening the same project must never inherit it.
 *
 * Same-tab updates propagate via a custom `computer-engine-changed` window
 * event (the Computer tab and the Playground rail must move together);
 * cross-tab updates come free through the browser `storage` event. Pattern
 * mirrors `previewed-client-storage.ts`.
 */

export type ComputerEngineChoice = "local" | "cloud";

const STORAGE_KEY = "mcp-computer-engine";
const EVENT_NAME = "computer-engine-changed";

interface ComputerEngineChangedDetail {
  projectId: string;
  engine: ComputerEngineChoice | null;
}

function readAll(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function loadComputerEngine(
  projectId: string,
): ComputerEngineChoice | null {
  const value = readAll()[projectId];
  return value === "local" || value === "cloud" ? value : null;
}

export function saveComputerEngine(
  projectId: string,
  engine: ComputerEngineChoice | null,
): void {
  try {
    const all = readAll();
    if (engine) {
      all[projectId] = engine;
    } else {
      delete all[projectId];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    const detail: ComputerEngineChangedDetail = { projectId, engine };
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
  } catch {
    // ignore
  }
}

export function subscribeComputerEngine(
  projectId: string,
  callback: () => void,
): () => void {
  const onCustom = (event: Event) => {
    const detail = (event as CustomEvent<ComputerEngineChangedDetail>).detail;
    if (!detail || detail.projectId === projectId) callback();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) callback();
  };
  window.addEventListener(EVENT_NAME, onCustom as EventListener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT_NAME, onCustom as EventListener);
    window.removeEventListener("storage", onStorage);
  };
}
