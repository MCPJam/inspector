import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";
import type { ProjectMember } from "@/hooks/useProjects";

/** Project-shared history rows: thread owner avatar (includes your own threads). */
export type ProjectThreadOwnerAvatar =
  | { status: "show"; displayName: string; imageUrl?: string }
  | { status: "generic" };

export function buildProjectOwnerProfileByUserId(
  members: ProjectMember[],
): Map<string, { imageUrl: string; name: string }> {
  const map = new Map<string, { imageUrl: string; name: string }>();
  for (const member of members) {
    if (!member.userId || !member.user) continue;
    map.set(member.userId, {
      imageUrl: member.user.imageUrl,
      name: member.user.name?.trim() || member.email || "Member",
    });
  }
  return map;
}

export function resolveProjectThreadOwnerAvatar(
  session: ChatHistorySession,
  ownerByUserId: Map<string, { imageUrl: string; name: string }>,
): ProjectThreadOwnerAvatar {
  if (!session.userId?.trim()) {
    return { status: "generic" };
  }
  const profile = ownerByUserId.get(session.userId);
  if (!profile) {
    return { status: "generic" };
  }
  return {
    status: "show",
    displayName: profile.name,
    imageUrl: profile.imageUrl?.trim() || undefined,
  };
}
