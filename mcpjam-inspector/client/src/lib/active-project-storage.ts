const LEGACY_ACTIVE_PROJECT_STORAGE_KEY = "convex-active-project-id";

export function getActiveProjectStorageKey(actorKey: string) {
  return `${LEGACY_ACTIVE_PROJECT_STORAGE_KEY}:${actorKey}`;
}

export function readStoredActiveProjectId(actorKey: string | null) {
  if (!actorKey || typeof window === "undefined") {
    return null;
  }
  return localStorage.getItem(getActiveProjectStorageKey(actorKey));
}

export function writeStoredActiveProjectId(
  actorKey: string | null,
  projectId: string | null,
) {
  if (!actorKey || typeof window === "undefined") {
    return;
  }
  const storageKey = getActiveProjectStorageKey(actorKey);
  if (projectId) {
    localStorage.setItem(storageKey, projectId);
    return;
  }
  localStorage.removeItem(storageKey);
}

export function clearLegacyActiveProjectStorage() {
  if (typeof window === "undefined") {
    return;
  }
  localStorage.removeItem(LEGACY_ACTIVE_PROJECT_STORAGE_KEY);
}
