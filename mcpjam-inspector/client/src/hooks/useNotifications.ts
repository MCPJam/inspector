import { useQuery, useMutation } from "convex/react";

export type NotificationType =
  | "workspace_added"
  | "workspace_removed"
  | "organization_added"
  | "organization_removed";

export interface Notification {
  _id: string;
  userId: string;
  type: NotificationType;
  entityId: string;
  entityName: string;
  actorId?: string;
  actorName?: string;
  isRead: boolean;
  createdAt: number;
  readAt?: number;
}

export function useNotifications({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const notifications = useQuery(
    "notifications:getMyNotifications" as any,
    isAuthenticated ? ({} as any) : "skip",
  ) as Notification[] | undefined;

  const unreadCount = useQuery(
    "notifications:getUnreadCount" as any,
    isAuthenticated ? ({} as any) : "skip",
  ) as number | undefined;

  const isLoading = isAuthenticated && notifications === undefined;

  return {
    notifications: notifications ?? [],
    unreadCount: unreadCount ?? 0,
    isLoading,
  };
}

export function useNotificationMutations() {
  const markAsRead = useMutation("notifications:markAsRead" as any);
  const markAllAsRead = useMutation("notifications:markAllAsRead" as any);
  const clearAllNotifications = useMutation(
    "notifications:clearAllNotifications" as any,
  );

  return {
    markAsRead,
    markAllAsRead,
    clearAllNotifications,
  };
}
