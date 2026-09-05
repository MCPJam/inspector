/**
 * Recovery for a lazy chunk the browser can no longer fetch.
 *
 * A tab that was open across a deploy still holds the previous build's module
 * graph: the first `import()` after the deploy asks for a hashed asset the new
 * build no longer emits, and the browser reports
 * `Failed to fetch dynamically imported module: .../assets/<name>-<hash>.js`.
 * Staging has a second way to produce the same message — its Cloudflare Access
 * session expires and the asset request is answered with an HTML login
 * redirect, which is not a module either.
 *
 * Both are fixed by the same thing, and only by it: a full document load. The
 * document request re-reads `index.html` (picking up the new hashes) and, on
 * staging, goes through the Access redirect that a module fetch cannot. So
 * instead of showing the raw fetch failure as a crash, reload once.
 *
 * "Once" is the whole difficulty. If the chunk is genuinely gone — a broken
 * deploy, an asset that was never uploaded — reloading on every failure is an
 * infinite refresh loop that is strictly worse than the error screen. The
 * cooldown stamp in `sessionStorage` bounds it: one reload per tab per window,
 * and after that the user sees a screen that explains itself.
 */

const RELOAD_STAMP_KEY = "mcpjam:stale-chunk-reload-at";

/**
 * Long enough to cover a reload plus the user navigating back to the surface
 * that failed (the asset request that fails second is not the one that failed
 * first), short enough that a later, unrelated deploy still recovers on its
 * own rather than inheriting an hours-old stamp.
 */
export const RELOAD_COOLDOWN_MS = 60_000;

export const STALE_CHUNK_MESSAGE =
  "MCPJam was updated while this tab was open. Reload to load the latest version.";

/**
 * Matched on message text because that is all there is. Chrome, Firefox and
 * Safari each word this differently and none of them expose a code, a type or
 * a distinguishable error class for it.
 */
const STALE_CHUNK_PATTERNS = [
  // Chrome / Edge
  "failed to fetch dynamically imported module",
  // Firefox
  "error loading dynamically imported module",
  // Safari
  "importing a module script failed",
  // Vite's CSS preload helper
  "unable to preload css",
  // An HTML login page or SPA fallback served where a module was expected
  "is not a valid javascript mime type",
  "expected a javascript module script",
];

export function isStaleChunkError(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  if (typeof error === "object" && (error as Error).name === "ChunkLoadError") {
    return true;
  }
  const raw =
    typeof error === "string"
      ? error
      : (error as { message?: unknown }).message;
  if (typeof raw !== "string") return false;
  const haystack = raw.toLowerCase();
  return STALE_CHUNK_PATTERNS.some((pattern) => haystack.includes(pattern));
}

/** Storage is unavailable in a sandboxed iframe and throws on access there. */
function readStamp(): number | null {
  try {
    const raw = window.sessionStorage.getItem(RELOAD_STAMP_KEY);
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStamp(at: number): void {
  try {
    window.sessionStorage.setItem(RELOAD_STAMP_KEY, String(at));
  } catch {
    // Without storage the cooldown cannot be enforced across the reload, so
    // the reload below is not attempted — see `attemptStaleChunkRecovery`.
  }
}

export type StaleChunkRecovery = "reloading" | "cooldown";

/**
 * Reload the document, unless this tab already did so recently.
 *
 * Returns what it decided, so the caller can tell "a reload is on its way"
 * from "we already tried that, show the user the error".
 */
export function attemptStaleChunkRecovery(): StaleChunkRecovery {
  const now = Date.now();
  const last = readStamp();
  if (last !== null && now - last < RELOAD_COOLDOWN_MS) return "cooldown";

  writeStamp(now);
  // Re-read rather than trust the write. If storage is unavailable the stamp
  // is lost, and reloading without a durable cooldown is the refresh loop
  // this whole module exists to avoid.
  if (readStamp() === null) return "cooldown";

  window.location.reload();
  return "reloading";
}

/**
 * Catch the failures no React boundary sees.
 *
 * `vite:preloadError` fires for a failed dependency preload, and a rejected
 * `import()` outside a component (analytics bundles, an event handler) only
 * ever reaches `unhandledrejection`. Both paths are the same stale build as a
 * boundary-caught one, and both are silent without this.
 *
 * `vite:preloadError` is deliberately NOT cancelled: preventing the default
 * only suppresses Vite's rethrow, and swallowing it would leave the surface
 * half-rendered if the reload is on cooldown.
 */
export function installStaleChunkRecovery(): void {
  window.addEventListener("vite:preloadError", (event) => {
    if (isStaleChunkError((event as Event & { payload?: unknown }).payload)) {
      attemptStaleChunkRecovery();
    }
  });

  window.addEventListener("unhandledrejection", (event) => {
    if (isStaleChunkError(event.reason)) attemptStaleChunkRecovery();
  });
}
