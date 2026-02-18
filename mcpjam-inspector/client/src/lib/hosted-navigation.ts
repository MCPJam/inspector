import {
  isHostedHashTabAllowed,
  normalizeHostedHashTab,
} from "./hosted-tab-policy";

export interface HostedNavigationResolution {
  normalizedParts: string[];
  normalizedSection: string;
  normalizedTab: string;
  rawSection: string;
  isBlocked: boolean;
  organizationId?: string;
  shouldSelectAllServers: boolean;
  shouldClearChatMessages: boolean;
}

export function getNormalizedHashParts(hashValue: string): string[] {
  const rawHash = hashValue.replace(/^#/, "");
  const trimmedHash = rawHash.startsWith("/") ? rawHash.slice(1) : rawHash;
  const hashParts = (trimmedHash || "servers").split("/");
  hashParts[0] = normalizeHostedHashTab(hashParts[0] || "servers");
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

  return {
    normalizedParts,
    normalizedSection,
    normalizedTab,
    rawSection,
    isBlocked: hostedMode && !isHostedHashTabAllowed(normalizedTab),
    organizationId,
    shouldSelectAllServers: normalizedTab === "chat-v2",
    shouldClearChatMessages: normalizedTab !== "chat-v2",
  };
}
