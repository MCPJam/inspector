const LEGACY_ACTIVE_ORGANIZATION_STORAGE_KEY = "active-organization-id";

export function getActiveOrganizationStorageKey(userId: string) {
  return `${LEGACY_ACTIVE_ORGANIZATION_STORAGE_KEY}:${userId}`;
}

export function readStoredActiveOrganizationId(userId: string | null) {
  if (!userId || typeof window === "undefined") {
    return undefined;
  }

  return (
    localStorage.getItem(getActiveOrganizationStorageKey(userId)) ?? undefined
  );
}

export function writeStoredActiveOrganizationId(
  userId: string | null,
  organizationId: string | undefined,
) {
  if (!userId || typeof window === "undefined") {
    return;
  }

  const storageKey = getActiveOrganizationStorageKey(userId);
  if (organizationId) {
    localStorage.setItem(storageKey, organizationId);
    return;
  }

  localStorage.removeItem(storageKey);
}

export function clearLegacyActiveOrganizationStorage() {
  if (typeof window === "undefined") {
    return;
  }

  localStorage.removeItem(LEGACY_ACTIVE_ORGANIZATION_STORAGE_KEY);
}
