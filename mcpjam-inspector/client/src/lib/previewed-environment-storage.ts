/**
 * "Previewed environment" — the Project Environment the user has currently
 * chosen for a given project (Phase 2). Exact structural mirror of
 * `previewed-client-storage.ts`: `localStorage` under
 * `mcp-previewed-environment-id` (an object keyed by `projectId` →
 * `environmentId`), same-tab propagation through a custom
 * `previewed-environment-changed` event, cross-tab through `storage`.
 *
 * A SEPARATE key from the previewed host on purpose. The two are not
 * alternatives stored in one slot: selecting an environment does adjust the
 * previewed host (the environment's host drives presentation), and collapsing
 * them would make "clear the environment" indistinguishable from "clear the
 * host", stranding the Playground with no host at all.
 */

const STORAGE_KEY = "mcp-previewed-environment-id";
const EVENT_NAME = "previewed-environment-changed";

interface PreviewedEnvironmentChangedDetail {
  projectId: string;
  environmentId: string | null;
}

export function loadPreviewedEnvironmentId(projectId: string): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw) as Record<string, string | null>;
    const value = all[projectId];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function savePreviewedEnvironmentId(
  projectId: string,
  environmentId: string | null
): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, string | null>) : {};
    if (environmentId) {
      all[projectId] = environmentId;
    } else {
      delete all[projectId];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    const detail: PreviewedEnvironmentChangedDetail = {
      projectId,
      environmentId,
    };
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
  } catch {
    // ignore
  }
}

export function subscribePreviewedEnvironmentId(
  projectId: string,
  callback: () => void
): () => void {
  const onCustom = (event: Event) => {
    const detail = (event as CustomEvent<PreviewedEnvironmentChangedDetail>)
      .detail;
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
