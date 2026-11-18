import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";

const AnnouncementQueue = createContext<{
  active: string | undefined;
  enqueue: (id: string) => () => void;
} | null>(null);

export function AnnouncementQueueProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<string[]>([]);
  const enqueue = useCallback((id: string) => {
    setQueue((current) => [...current, id]);
    return () => setQueue((current) => current.filter((entry) => entry !== id));
  }, []);

  return (
    <AnnouncementQueue.Provider value={{ active: queue[0], enqueue }}>
      {children}
    </AnnouncementQueue.Provider>
  );
}

export function useAnnouncementSlot(eligible: boolean) {
  const queue = useContext(AnnouncementQueue);
  const id = useId();
  const [isMounted, setIsMounted] = useState(false);
  const contentRef = useCallback((node: HTMLElement | null) => {
    setIsMounted(node !== null);
  }, []);
  // Keep the slot through exit animations, not just until dismissal is requested.
  const needsSlot = eligible || isMounted;
  const enqueue = queue?.enqueue;
  useLayoutEffect(() => {
    if (needsSlot) return enqueue?.(id);
  }, [enqueue, id, needsSlot]);

  return {
    open: eligible && (!queue || queue.active === id),
    contentRef,
  };
}
