import { toast } from "@/lib/toast";

const STALE_CHUNK_TOAST_ID = "stale-chunk-reload";
export const STALE_CHUNK_RELOAD_KEY = "mcpjam:stale-chunk-reload";
export const STALE_CHUNK_RELOAD_WINDOW_MS = 60_000;

const CHUNK_LOAD_ERROR_RE =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i;

export function isChunkLoadError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return CHUNK_LOAD_ERROR_RE.test(message);
}

// The `<script type="module" src="/assets/index-<hash>.js">` Vite writes into
// index.html changes with every build, so it doubles as the build id.
export function entryScriptSrc(doc: ParentNode): string | null {
  const script = doc.querySelector<HTMLScriptElement>(
    'script[type="module"][src]',
  );
  return script?.getAttribute("src") ?? null;
}

// Whether the server now serves a different build than this tab is running.
// `null` when it cannot be determined (offline, non-HTML answer), which is
// also what a dropped network looks like.
export async function isNewBuildServed(
  fetchFn: typeof fetch = fetch,
  doc: ParentNode = document,
): Promise<boolean | null> {
  const current = entryScriptSrc(doc);
  if (!current) return null;
  try {
    const response = await fetchFn(window.location.pathname, {
      cache: "no-store",
      headers: { Accept: "text/html" },
    });
    if (!response.ok) return null;
    const served = entryScriptSrc(
      new DOMParser().parseFromString(await response.text(), "text/html"),
    );
    if (!served) return null;
    return served !== current;
  } catch {
    return null;
  }
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

// Reloading again inside the window would loop if the served build itself
// cannot load; the prompt takes over instead.
export function claimAutomaticReload(
  storage: Storage | null,
  now: number,
): boolean {
  if (!storage) return true;
  try {
    const raw = storage.getItem(STALE_CHUNK_RELOAD_KEY);
    const last = raw === null ? Number.NaN : Number(raw);
    if (Number.isFinite(last) && now - last <= STALE_CHUNK_RELOAD_WINDOW_MS) {
      return false;
    }
    storage.setItem(STALE_CHUNK_RELOAD_KEY, String(now));
  } catch {
    // Storage unavailable (private mode / quota): still reload once.
  }
  return true;
}

// A reload throws away whatever the user is typing.
export function isEditing(doc: Document = document): boolean {
  const el = doc.activeElement;
  if (!el || el === doc.body) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    (el as HTMLElement).isContentEditable === true
  );
}

export type StaleChunkRecoveryDeps = {
  isNewBuildServed: () => Promise<boolean | null>;
  isEditing: () => boolean;
  claimAutomaticReload: () => boolean;
  reload: () => void;
};

const defaultDeps = (): StaleChunkRecoveryDeps => ({
  isNewBuildServed: () => isNewBuildServed(),
  isEditing: () => isEditing(),
  claimAutomaticReload: () =>
    claimAutomaticReload(sessionStorageOrNull(), Date.now()),
  reload: () => window.location.reload(),
});

export async function recoverFromStaleChunk(
  deps: StaleChunkRecoveryDeps,
): Promise<"reloaded" | "prompted"> {
  const newBuild = await deps.isNewBuildServed();
  if (newBuild === true) {
    if (!deps.isEditing() && deps.claimAutomaticReload()) {
      deps.reload();
      return "reloaded";
    }
    toast.warning("Reload MCPJam", {
      id: STALE_CHUNK_TOAST_ID,
      description: "A new version is available.",
      action: { label: "Reload", onClick: deps.reload },
    });
    return "prompted";
  }
  // Same build still served (or unknown): the same event fires when the
  // network drops, so the copy cannot promise a new version.
  toast.warning("Reload the page", {
    id: STALE_CHUNK_TOAST_ID,
    description: "Part of MCPJam didn't load.",
    action: { label: "Reload", onClick: deps.reload },
  });
  return "prompted";
}

// A tab still running an older build requests that build's content-hashed
// chunks. Once a deploy replaces them, every lazy import in the tab rejects
// until the page reloads, and the feature behind it fails silently. Vite
// dispatches `vite:preloadError` for each failed dynamic import in the
// bundle, including ones inside dependencies (streamdown's code highlighter),
// so one listener covers them all. The event is not cancelled: the import
// still rejects to its caller, which keeps its own fallback.
//
// Returns a function that removes the listener (for tests).
export function installStaleChunkRecovery(
  deps: StaleChunkRecoveryDeps = defaultDeps(),
): () => void {
  let pending: Promise<unknown> | null = null;
  const onPreloadError = () => {
    if (pending) return;
    pending = recoverFromStaleChunk(deps).finally(() => {
      pending = null;
    });
  };
  window.addEventListener("vite:preloadError", onPreloadError);
  return () => window.removeEventListener("vite:preloadError", onPreloadError);
}
