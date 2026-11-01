import { taskOwnerScope } from "@/shared/task-owner";

type ScopedTask = {
  scope?: string;
  connectionId?: string;
  sourceExecutionId?: string;
};

let legacyScope: string | undefined;
let ownedScope: string | undefined;

export function setTrackedTaskScope(scope: string | null | undefined): void {
  legacyScope = scope ?? undefined;
}

export function getTrackedTaskScope(): string | undefined {
  return legacyScope;
}

/** Existing bookmarks have no owner evidence; never assign them to an actor. */
export function setTrackedTaskOwner(
  projectId: string | null | undefined,
  ownerUserId: string | null | undefined,
): void {
  ownedScope = taskOwnerScope(projectId, ownerUserId);
}

export function getOwnedTaskScope(): string | undefined {
  return ownedScope;
}

export function isBoundTask(task: ScopedTask): boolean {
  return (
    task.connectionId !== undefined || task.sourceExecutionId !== undefined
  );
}

export function withTaskScope<T extends ScopedTask>(task: T): T {
  return {
    ...task,
    scope: task.scope ?? (isBoundTask(task) ? ownedScope : legacyScope),
  };
}

export function isActiveTaskScope(task: ScopedTask): boolean {
  if (isBoundTask(task))
    return ownedScope !== undefined && task.scope === ownedScope;
  return task.scope === legacyScope;
}

export function dismissedRegistryKey(
  serverId: string,
  selection?: { scope?: string; connectionId?: string; wire?: string },
): string {
  const base = `${selection?.scope ?? (selection?.connectionId !== undefined ? getOwnedTaskScope() : getTrackedTaskScope()) ?? ""}\u0000${serverId}`;
  return selection?.wire !== undefined || selection?.connectionId !== undefined
    ? `${base}\u0000${selection.wire ?? ""}\u0000${selection.connectionId ?? ""}`
    : base;
}
