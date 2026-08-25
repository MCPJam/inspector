import { useQuery, useMutation } from "convex/react";

export type NotificationType =
  | "project_added"
  | "project_removed"
  | "workspace_added"
  | "workspace_removed"
  | "organization_added"
  | "organization_removed"
  // Owner-targeted, unlike the rest: someone they invited has signed up and
  // the automatic seat charge needs them. Here the actor is the SUBJECT — the
  // person waiting on the seat — not whoever performed an action.
  | "organization_seat_payment_required"
  | "scheduled_eval_failed"
  | "scheduled_eval_paused";

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
