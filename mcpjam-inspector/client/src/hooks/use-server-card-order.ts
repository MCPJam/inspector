import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  loadServerOrder,
  saveServerOrder,
  serverCheckQueue,
  subscribeServerOrder,
} from "@/lib/server-check-queue";

export function reconcileServerOrder(
  names: readonly string[],
  previous?: readonly string[],
): string[] {
  const catalog = new Set(names);
  const existing = [...new Set(previous)].filter((name) => catalog.has(name));
  const known = new Set(existing);
  return [...catalog].filter((name) => !known.has(name)).concat(existing);
}

export function useServerCardOrder({
  projectId,
  queueProjectId,
  catalogNames,
  visibleNames,
  ready,
}: {
  projectId: string;
  queueProjectId: string;
  catalogNames: readonly string[];
  visibleNames: readonly string[];
  ready: boolean;
}) {
  const saved = useSyncExternalStore(
    subscribeServerOrder,
    () => loadServerOrder(projectId),
    () => undefined,
  );
  const catalogKey = JSON.stringify(catalogNames);
  const order = useMemo(
    () =>
      ready
        ? reconcileServerOrder(JSON.parse(catalogKey), saved)
        : (saved ?? []),
    [catalogKey, saved, ready],
  );

  useEffect(() => {
    if (!ready) return;
    saveServerOrder(projectId, order);
    if (queueProjectId !== projectId)
      serverCheckQueue.setOrder(queueProjectId, order);
  }, [projectId, queueProjectId, ready, order]);

  const setOrderedServerNames = useCallback(
    (names: string[]) => {
      if (!ready) return;
      const catalog = new Set(catalogNames);
      saveServerOrder(
        projectId,
        names.filter((name) => catalog.has(name)),
      );
    },
    [projectId, catalogKey, ready],
  );

  const visible = new Set(visibleNames);
  const known = new Set(order);
  return {
    orderedServerNames: [
      ...order.filter((name) => visible.has(name)),
      ...visibleNames.filter((name) => !known.has(name)),
    ],
    catalogOrder: ready ? order : undefined,
    setOrderedServerNames,
  };
}
