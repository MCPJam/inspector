import {
  isHostedHashTabAllowed,
  normalizeHostedHashTab,
} from "./hosted-tab-policy";

export type OrganizationRouteSection = "overview" | "billing";

export interface HostedNavigationResolution {
  normalizedParts: string[];
  normalizedSection: string;
  normalizedTab: string;
  rawSection: string;
  isBlocked: boolean;
  organizationId?: string;
  organizationSection?: OrganizationRouteSection;
  shouldSelectAllServers: boolean;
  shouldClearChatMessages: boolean;
}

export function getWorkspaceSwitchNavigationTarget({
  activeTab,
  activeOrganizationId,
  nextWorkspaceOrganizationId,
}: {
  activeTab: string;
  activeOrganizationId?: string;
  nextWorkspaceOrganizationId?: string;
}): string | null {
  if (activeTab !== "organizations") {
    return null;
  }

  if (
    !activeOrganizationId ||
    !nextWorkspaceOrganizationId ||
    nextWorkspaceOrganizationId !== activeOrganizationId
  ) {
    return "servers";
  }

  return null;
}

export function getInvalidOrganizationRouteNavigationTarget({
  routeTab,
  routeOrganizationId,
  isLoadingOrganizations,
  hasRouteOrganization,
}: {
  routeTab: string;
  routeOrganizationId?: string;
  isLoadingOrganizations: boolean;
  hasRouteOrganization: boolean;
}): string | null {
  if (routeTab !== "organizations" || isLoadingOrganizations) {
    return null;
  }

  if (!routeOrganizationId || !hasRouteOrganization) {
    return "servers";
  }

  return null;
}

function normalizeOrganizationSection(
  section: string | undefined,
): OrganizationRouteSection {
  return section === "billing" ? "billing" : "overview";
}

export function getNormalizedHashParts(hashValue: string): string[] {
  const rawHash = hashValue.replace(/^#/, "");
  const trimmedHash = rawHash.startsWith("/") ? rawHash.slice(1) : rawHash;
  const hashParts = (trimmedHash || "servers").split("/");
  hashParts[0] = normalizeHostedHashTab(hashParts[0] || "servers");

  if (hashParts[0] === "organizations" && hashParts[1]) {
    const section = normalizeOrganizationSection(hashParts[2]);
    return section === "billing"
      ? ["organizations", hashParts[1], "billing"]
      : ["organizations", hashParts[1]];
  }

  return hashParts;
}

export function resolveHostedNavigation(
  target: string,
  hostedMode: boolean,
): HostedNavigationResolution {
  const rawWithoutPrefix = target.replace(/^#/, "").replace(/^\/+/, "");
  const rawSection = rawWithoutPrefix || "servers";
  const normalizedParts = getNormalizedHashParts(target);
  const normalizedSection = normalizedParts.join("/");
  const normalizedTab = normalizedParts[0] || "servers";
  const organizationId =
    normalizedTab === "organizations" && normalizedParts[1]
      ? normalizedParts[1]
      : undefined;
  const organizationSection =
    normalizedTab === "organizations" && organizationId
      ? normalizeOrganizationSection(normalizedParts[2])
      : undefined;

  return {
    normalizedParts,
    normalizedSection,
    normalizedTab,
    rawSection,
    isBlocked: hostedMode && !isHostedHashTabAllowed(normalizedTab),
    organizationId,
    organizationSection,
    shouldSelectAllServers: normalizedTab === "chat-v2",
    shouldClearChatMessages: normalizedTab !== "chat-v2",
  };
}
