import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";
import type { WorkspaceMember } from "@/hooks/useWorkspaces";

/** Workspace-shared history rows: thread owner avatar (includes your own threads). */
export type WorkspaceThreadOwnerAvatar =
  | { status: "show"; displayName: string; imageUrl?: string }
  | { status: "generic" };

export function buildWorkspaceOwnerProfileByUserId(
  members: WorkspaceMember[],
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

export function resolveWorkspaceThreadOwnerAvatar(
  session: ChatHistorySession,
  ownerByUserId: Map<string, { imageUrl: string; name: string }>,
): WorkspaceThreadOwnerAvatar {
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
