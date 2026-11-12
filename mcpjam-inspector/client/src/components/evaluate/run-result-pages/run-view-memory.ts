import { useCallback, useEffect, useRef, type UIEvent } from "react";

/**
 * What a run's grid shows, kept for the back button. In memory
 * only: a reload starts clean, and filters stay out of the run's URL.
 */
export type RunView = {
  search: string;
  status: string;
  view: "results" | "metrics";
  client: string;
  model: string;
  scrollTop: number;
};

const views = new Map<string, Partial<RunView>>();

/** `runId` is undefined while result pages are off, which reads nothing. */
export function readRunView(runId: string | undefined): Partial<RunView> {
  return (runId && views.get(runId)) || {};
}

export function rememberRunView(
  runId: string | undefined,
  patch: Partial<RunView>,
): void {
  if (runId) views.set(runId, { ...views.get(runId), ...patch });
}

/** How long the restore keeps up with content that loads above the grid. */
const RESTORE_WINDOW_MS = 2000;

/**
 * The run grid's scroll position, for its scrolling container. Panels above
 * the grid finish loading after its rows, so the restore is re-applied as the
 * content grows until the saved spot is reachable or the window closes.
 */
export function useRunScrollMemory(
  runId: string | undefined,
  rowsReady: boolean,
) {
  const ref = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  useEffect(() => {
    const element = ref.current;
    if (!runId || !rowsReady || restored.current || !element) return;
    const top = readRunView(runId).scrollTop;
    const reached = () =>
      element.scrollHeight - element.clientHeight >= (top ?? 0);
    const apply = () => {
      if (top) element.scrollTop = top;
      if (reached()) restored.current = true;
    };
    apply();
    const content = element.firstElementChild;
    if (restored.current || !content || typeof ResizeObserver === "undefined") {
      restored.current = true;
      return;
    }
    const observer = new ResizeObserver(() => {
      apply();
      if (restored.current) observer.disconnect();
    });
    observer.observe(content);
    const stop = window.setTimeout(() => {
      restored.current = true;
      observer.disconnect();
    }, RESTORE_WINDOW_MS);
    return () => {
      observer.disconnect();
      window.clearTimeout(stop);
    };
  }, [runId, rowsReady]);
  const onScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      // Layout shifts before the restore must not overwrite the saved spot.
      if (restored.current)
        rememberRunView(runId, { scrollTop: event.currentTarget.scrollTop });
    },
    [runId],
  );
  return { ref, onScroll };
}
