import { toast } from "@/lib/toast";

const STALE_CHUNK_TOAST_ID = "stale-chunk-reload";

// A tab still running an older build requests that build's content-hashed
// chunks. Once a deploy replaces them, every lazy import in the tab rejects
// until the page reloads, and the feature behind it fails silently. Vite
// dispatches `vite:preloadError` for each failed dynamic import in the
// bundle, including ones inside dependencies (streamdown's code highlighter),
// so one listener covers them all. The event is not cancelled: the import
// still rejects to its caller, which keeps its own fallback.
//
// Returns a function that removes the listener (for tests).
export function installStaleChunkRecovery(): () => void {
  const onPreloadError = () => {
    // The same event fires when the network drops, so the copy cannot promise
    // a new version.
    toast.warning("Please refresh the page", {
      id: STALE_CHUNK_TOAST_ID,
      description: "Something didn’t load. Refresh to try again.",
      action: { label: "Refresh", onClick: () => window.location.reload() },
    });
  };
  window.addEventListener("vite:preloadError", onPreloadError);
  return () => window.removeEventListener("vite:preloadError", onPreloadError);
}
