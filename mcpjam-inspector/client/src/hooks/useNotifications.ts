import { useMutation } from "convex/react";
import { useSoftQuery } from "@/hooks/use-soft-query";

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
  // Approver-targeted: someone asked to join a project. `entityId` is the
  // access request, `entityName` the project, and the actor the requester.
  | "project_access_requested"
  // Approver-targeted, the same as above for a request to join the
  // organization: `entityName` is the organization.
  | "organization_access_requested"
  | "scheduled_eval_failed"
  | "scheduled_eval_paused"
  // Org-wide, and addressed to the people who can act: the organization
  // crossed one of its spend-budget alert thresholds, or reached the cap.
  // `entityName` is the organization, and `entityId` its id.
  | "organization_spend_threshold";

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
  // Soft: the sidebar's unread badge reads this on every page, and a failed
  // read must not replace the app. A failure reads as an empty inbox.
  const { data: notifications, error } = useSoftQuery<Notification[]>(
    "notifications:getMyNotifications",
    isAuthenticated ? {} : "skip",
  );

  const { data: unreadCount } = useSoftQuery<number>(
    "notifications:getUnreadCount",
    isAuthenticated ? {} : "skip",
  );

  const isLoading = isAuthenticated && notifications === undefined && !error;

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
