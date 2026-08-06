import {
  buildOrganizationPath,
  type OrganizationRouteSection,
} from "./app-navigation";

export interface PendingInviteOrgMarker {
  organizationId: string;
  returnPath: string;
  startedAt: number;
}

const PENDING_INVITE_ORG_STORAGE_KEY = "mcpjam:pending-invite-org-marker";

function normalizeInviteOrgId(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || !/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function parseOrganizationReturnPath(path: string | null | undefined): {
  orgId: string;
  section?: OrganizationRouteSection;
} | null {
  const trimmed = path?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmed, "https://app.mcpjam.local");
  } catch {
    return null;
  }

  const segments = url.pathname.replace(/^\/+/, "").split("/");
  const orgId = normalizeInviteOrgId(segments[1]);
  const sectionSegment = segments[2];
  if (segments[0] !== "organizations" || !orgId || segments.length > 3) {
    return null;
  }

  if (sectionSegment === undefined || sectionSegment === "") {
    return { orgId };
  }

  if (sectionSegment !== "billing" && sectionSegment !== "models") {
    return null;
  }

  return { orgId, section: sectionSegment };
}

function createPendingInviteOrgMarker(
  organizationId: string,
  section?: OrganizationRouteSection
): PendingInviteOrgMarker | null {
  const normalizedOrgId = normalizeInviteOrgId(organizationId);
  if (!normalizedOrgId) {
    return null;
  }

  return {
    organizationId: normalizedOrgId,
    returnPath: buildOrganizationPath(normalizedOrgId, section),
    startedAt: Date.now(),
  };
}

function normalizePendingInviteOrgMarker(
  value: unknown
): PendingInviteOrgMarker | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as {
    organizationId?: unknown;
    returnPath?: unknown;
    startedAt?: unknown;
  };
  if (
    typeof raw.organizationId !== "string" ||
    typeof raw.returnPath !== "string" ||
    typeof raw.startedAt !== "number" ||
    !Number.isFinite(raw.startedAt)
  ) {
    return null;
  }

  const parsedReturnPath = parseOrganizationReturnPath(raw.returnPath);
  if (!parsedReturnPath || parsedReturnPath.orgId !== raw.organizationId) {
    return null;
  }

  return {
    organizationId: parsedReturnPath.orgId,
    returnPath: buildOrganizationPath(
      parsedReturnPath.orgId,
      parsedReturnPath.section
    ),
    startedAt: raw.startedAt,
  };
}

export function writePendingInviteOrgMarker(
  marker: PendingInviteOrgMarker
): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }

  const normalizedMarker = normalizePendingInviteOrgMarker(marker);
  if (!normalizedMarker) {
    return;
  }

  try {
    sessionStorage.setItem(
      PENDING_INVITE_ORG_STORAGE_KEY,
      JSON.stringify(normalizedMarker)
    );
  } catch {
    // Ignore storage failures.
  }
}

export function writePendingInviteOrgMarkerForPath(
  path: string | null | undefined
): PendingInviteOrgMarker | null {
  const parsed = parseOrganizationReturnPath(path);
  if (!parsed) {
    return null;
  }

  const marker = createPendingInviteOrgMarker(parsed.orgId, parsed.section);
  if (!marker) {
    return null;
  }

  writePendingInviteOrgMarker(marker);
  return marker;
}

export function readPendingInviteOrgMarker(): PendingInviteOrgMarker | null {
  if (typeof sessionStorage === "undefined") {
    return null;
  }

  try {
    const raw = sessionStorage.getItem(PENDING_INVITE_ORG_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    return normalizePendingInviteOrgMarker(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function clearPendingInviteOrgMarker(): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }

  try {
    sessionStorage.removeItem(PENDING_INVITE_ORG_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export function capturePendingInviteOrgFromUrl(): PendingInviteOrgMarker | null {
  if (typeof window === "undefined") {
    return null;
  }

  const url = new URL(window.location.href);
  const orgId = normalizeInviteOrgId(url.searchParams.get("invite_org"));
  if (!orgId) {
    return null;
  }

  const marker = createPendingInviteOrgMarker(orgId);
  if (!marker) {
    return null;
  }

  writePendingInviteOrgMarker(marker);
  url.searchParams.delete("invite_org");
  window.history.replaceState({}, "", url.pathname + url.search + url.hash);
  return marker;
}
