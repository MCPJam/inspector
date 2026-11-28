import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  loadServerOrder,
  saveServerOrder,
  serverCheckQueue,
  subscribeServerOrder,
} from "@/lib/server-check-queue";

type Rename = { from: string; to: string; saved: boolean; pending: boolean };
type ImportGroup = {
  names: Set<string>;
  pending: Set<string>;
  saved: Set<string>;
};
// Operation intent is browser-session-only, just like the order fallback. Keep it
// scoped to its origin even when Connect unmounts or switches projects mid-save.
const renames = new Map<string, Set<Rename>>();
const imports = new Map<string, Set<ImportGroup>>();
const listeners = new Set<() => void>();
let revision = 0;
function changed() {
  revision++;
  for (const listener of listeners) listener();
}
function subscribeOperations(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function canonicalName(name: string, pending: Iterable<Rename>) {
  for (const rename of pending) {
    if (name === rename.from || name === rename.to)
      return rename.saved ? rename.to : rename.from;
  }
  return name;
}

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
  const operationsRevision = useSyncExternalStore(
    subscribeOperations,
    () => revision,
    () => 0,
  );
  const catalogKey = JSON.stringify(catalogNames);
  const pendingRenames = [...(renames.get(projectId) ?? [])];
  const importGroups = [...(imports.get(projectId) ?? [])];
  const order = useMemo(() => {
    if (!ready) return saved ?? [];
    const names: string[] = JSON.parse(catalogKey);
    const catalog = names.map((name) => canonicalName(name, pendingRenames));
    for (const rename of pendingRenames) {
      catalog.push(rename.saved ? rename.to : rename.from);
    }
    const held = new Set(
      importGroups.flatMap((group) =>
        [...group.names].filter((name) => !group.saved.has(name)),
      ),
    );
    let next = reconcileServerOrder(
      catalog.filter((name) => !held.has(name)),
      saved,
    );
    for (const group of importGroups) {
      const members = [
        ...new Set(names.filter((name) => group.saved.has(name))),
      ];
      const leading = new Set(members);
      next = [...members, ...next.filter((name) => !leading.has(name))];
    }
    return next;
  }, [projectId, catalogKey, saved, ready, operationsRevision]);
  const effectiveOrder = useMemo(
    () =>
      order.map((name) => {
        if (catalogNames.includes(name)) return name;
        const rename = pendingRenames.find(
          (rename) => rename.from === name || rename.to === name,
        );
        return rename ? (rename.saved ? rename.from : rename.to) : name;
      }),
    [order, catalogKey, operationsRevision],
  );

  useEffect(() => {
    if (!ready) return;
    saveServerOrder(projectId, order);
    serverCheckQueue.setOrder(projectId, effectiveOrder);
    if (queueProjectId !== projectId)
      serverCheckQueue.setOrder(queueProjectId, effectiveOrder);
    const catalog = new Set(catalogNames);
    let settled = false;
    for (const rename of pendingRenames) {
      const present = rename.saved ? rename.to : rename.from;
      const absent = rename.saved ? rename.from : rename.to;
      if (!rename.pending && catalog.has(present) && !catalog.has(absent)) {
        renames.get(projectId)?.delete(rename);
        settled = true;
      }
    }
    for (const group of importGroups) {
      if (
        !group.pending.size &&
        [...group.saved].every((name) => catalog.has(name))
      ) {
        imports.get(projectId)?.delete(group);
        settled = true;
      }
    }
    if (settled) changed();
  }, [
    projectId,
    queueProjectId,
    ready,
    order,
    effectiveOrder,
    catalogKey,
    operationsRevision,
  ]);

  const setOrderedServerNames = useCallback(
    (names: string[]) => {
      if (!ready) return;
      const pending = renames.get(projectId) ?? [];
      const catalog = new Set(
        catalogNames.map((name) => canonicalName(name, pending)),
      );
      saveServerOrder(
        projectId,
        names
          .map((name) => canonicalName(name, pending))
          .filter((name) => catalog.has(name)),
      );
    },
    [projectId, catalogKey, ready],
  );

  const beginRename = useCallback(
    (from: string, to: string) => {
      if (!ready || from === to) return (_saved: boolean) => {};
      const rename: Rename = { from, to, saved: false, pending: true };
      const pending = renames.get(projectId) ?? new Set<Rename>();
      renames.set(projectId, pending);
      pending.add(rename);
      changed();
      return (saved: boolean) => {
        rename.pending = false;
        rename.saved = saved;
        if (saved) {
          saveServerOrder(
            projectId,
            (loadServerOrder(projectId) ?? order).map((name) =>
              name === from ? to : name,
            ),
          );
        }
        changed();
      };
    },
    [projectId, ready, order],
  );

  const beginImport = useCallback(
    (names: string[]) => {
      const known = new Set(catalogNames);
      const additions = new Set(
        ready ? names.filter((name) => !known.has(name)) : [],
      );
      const group: ImportGroup = {
        names: additions,
        pending: new Set(additions),
        saved: new Set(),
      };
      const groups = imports.get(projectId) ?? new Set<ImportGroup>();
      imports.set(projectId, groups);
      if (additions.size) {
        groups.add(group);
        changed();
      }
      return (name: string, saved: boolean) => {
        if (!group.pending.delete(name)) return;
        if (saved) group.saved.add(name);
        changed();
      };
    },
    [projectId, ready, catalogKey],
  );

  const visible = new Set(visibleNames);
  const displayedOrder = order.map((name) => {
    if (visible.has(name)) return name;
    const rename = pendingRenames.find(
      (rename) => rename.from === name || rename.to === name,
    );
    return rename ? (rename.saved ? rename.from : rename.to) : name;
  });
  const known = new Set([
    ...order,
    ...pendingRenames.flatMap(({ from, to }) => [from, to]),
    ...importGroups.flatMap((group) => [...group.names]),
  ]);
  return {
    orderedServerNames: [
      ...displayedOrder.filter((name) => visible.has(name)),
      ...visibleNames.filter((name) => !known.has(name)),
    ],
    catalogOrder: ready ? effectiveOrder : undefined,
    setOrderedServerNames,
    beginRename,
    beginImport,
  };
}
