import { useRef, useEffect, useCallback } from "react";

/**
 * IntersectionObserver-based scroll tracking.
 * Returns a `registerSection` callback to bind DOM elements to step IDs.
 */
export function useScrollSpy(
  sectionIds: readonly string[],
  scrollContainerRef: React.RefObject<HTMLElement | null>,
  onActiveChange: (id: string) => void,
  enabled: boolean,
) {
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map());
  const rafId = useRef(0);

  const registerSection = useCallback((id: string, el: HTMLElement | null) => {
    if (el) sectionRefs.current.set(id, el);
    else sectionRefs.current.delete(id);
  }, []);

  useEffect(() => {
    if (!enabled || !scrollContainerRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        cancelAnimationFrame(rafId.current);
        rafId.current = requestAnimationFrame(() => {
          let bestEntry: IntersectionObserverEntry | null = null;
          for (const entry of entries) {
            if (entry.isIntersecting) {
              if (
                !bestEntry ||
                entry.intersectionRatio > bestEntry.intersectionRatio
              ) {
                bestEntry = entry;
              }
            }
          }
          if (bestEntry) {
            const id = bestEntry.target.getAttribute("data-step-id");
            if (id) onActiveChange(id);
          }
        });
      },
      {
        root: scrollContainerRef.current,
        rootMargin: "-10% 0px -60% 0px",
        threshold: [0, 0.25, 0.5, 0.75, 1],
      },
    );

    for (const id of sectionIds) {
      const el = sectionRefs.current.get(id);
      if (el) observer.observe(el);
    }

    return () => {
      cancelAnimationFrame(rafId.current);
      observer.disconnect();
    };
  }, [sectionIds, enabled, onActiveChange, scrollContainerRef]);

  return { registerSection };
}
