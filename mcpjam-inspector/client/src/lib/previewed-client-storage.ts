/**
 * "Previewed host" — the host the user has currently chosen for a given
 * project. Source of truth lives in `localStorage` under
 * `mcp-previewed-host-id` (an object keyed by `projectId` → `hostId`).
 *
 * Surfaces that read/write this value (Connect's `HostOverlayBar`,
 * Playground's `PlaygroundHeader`) all go through these helpers so they
 * stay in sync. Same-tab updates are propagated via a custom
 * `previewed-host-changed` window event; cross-tab updates come for free
 * through the browser `storage` event.
 */

const STORAGE_KEY = "mcp-previewed-host-id";
const EVENT_NAME = "previewed-host-changed";

interface PreviewedHostChangedDetail {
  projectId: string;
  hostId: string | null;
}

/**
 * The document has always been a `projectId` → `hostId` map. Anything else
 * under the key (an unscoped bare id, an array, a half-written value) is read
 * as "no host for any project" rather than trusted — a host id that isn't
 * filed under a project can't be attributed to one, and guessing would preview
 * another project's host.
 */
function readAll(): Record<string, string | null> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, string | null>;
  } catch {
    return {};
  }
}

export function loadPreviewedHostId(projectId: string): string | null {
  const value = readAll()[projectId];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function savePreviewedHostId(
  projectId: string,
  hostId: string | null,
): void {
  try {
    const all = readAll();
    if (hostId) {
      all[projectId] = hostId;
    } else {
      delete all[projectId];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    const detail: PreviewedHostChangedDetail = { projectId, hostId };
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
  } catch {
    // ignore
  }
}

export function subscribePreviewedHostId(
  projectId: string,
  callback: () => void,
): () => void {
  const onCustom = (event: Event) => {
    const detail = (event as CustomEvent<PreviewedHostChangedDetail>).detail;
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
