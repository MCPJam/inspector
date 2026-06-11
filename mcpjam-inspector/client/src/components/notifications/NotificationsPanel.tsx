import { Building2, FolderKanban, Inbox } from "lucide-react";
import { useConvexAuth } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { PopoverContent } from "@mcpjam/design-system/popover";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import {
  useNotifications,
  useNotificationMutations,
  Notification,
  NotificationType,
} from "@/hooks/useNotifications";
import { cn } from "@/lib/utils";

function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

function getNotificationIcon(type: NotificationType) {
  if (type.startsWith("project")) {
    return <FolderKanban className="h-4 w-4" />;
  }
  return <Building2 className="h-4 w-4" />;
}

function getNotificationMessage(notification: Notification): string {
  const { type, entityName, actorName } = notification;
  const actor = actorName || "Someone";

  switch (type) {
    case "project_added":
      return `${actor} added you to project "${entityName}"`;
    case "project_removed":
      return `${actor} removed you from project "${entityName}"`;
    case "organization_added":
      return `${actor} added you to organization "${entityName}"`;
    case "organization_removed":
      return `${actor} removed you from organization "${entityName}"`;
    default:
      return "You have a new notification";
  }
}

function NotificationItem({
  notification,
  onMarkAsRead,
}: {
  notification: Notification;
  onMarkAsRead: (id: string) => void;
}) {
  const handleClick = () => {
    if (!notification.isRead) {
      onMarkAsRead(notification._id);
    }
  };

  return (
    <div
      className={cn(
        "flex items-start gap-3 p-3 border-b last:border-b-0 cursor-pointer transition-colors hover:bg-muted/50",
        !notification.isRead && "bg-muted/30"
      )}
      onClick={handleClick}
    >
      <div
        className={cn(
          "flex items-center justify-center h-8 w-8 rounded-full shrink-0",
          notification.type.includes("added")
            ? "bg-success/10 text-success"
            : "bg-destructive/10 text-destructive"
        )}
      >
        {getNotificationIcon(notification.type)}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm leading-tight">
          {getNotificationMessage(notification)}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {formatTimeAgo(notification.createdAt)}
        </p>
      </div>
      {!notification.isRead && (
        <div className="h-2 w-2 rounded-full bg-info shrink-0 mt-1.5" />
      )}
    </div>
  );
}

interface NotificationsPanelContentProps {
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}

/**
 * The notifications inbox, rendered as a `PopoverContent`. The caller owns
 * the `Popover` root and whatever trigger/anchor opens it (currently the
 * account menu's Notifications item).
 */
export function NotificationsPanelContent({
  side = "right",
  align = "end",
}: NotificationsPanelContentProps) {
  const { isAuthenticated } = useConvexAuth();
  const { notifications, isLoading } = useNotifications({
    isAuthenticated,
  });
  const { markAsRead, markAllAsRead, clearAllNotifications } =
    useNotificationMutations();
  const unreadCount = notifications.filter((n) => !n.isRead).length;

  const handleMarkAsRead = async (notificationId: string) => {
    try {
      await markAsRead({ notificationId });
    } catch (error) {
      console.error("Failed to mark notification as read:", error);
    }
  };

  const handleMarkAllAsRead = async () => {
    try {
      await markAllAsRead({});
    } catch (error) {
      console.error("Failed to mark all notifications as read:", error);
    }
  };

  const handleClearAll = async () => {
    try {
      await clearAllNotifications({});
    } catch (error) {
      console.error("Failed to clear notifications:", error);
    }
  };

  return (
    <PopoverContent
      className="w-80 p-0"
      align={align}
      side={side}
      sideOffset={8}
    >
      <div className="flex items-center justify-between p-3 border-b">
        <h4 className="font-semibold text-sm">Notifications</h4>
        <div className="flex items-center gap-1">
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-auto py-1 px-2 text-xs"
              onClick={handleMarkAllAsRead}
            >
              Mark all read
            </Button>
          )}
          {notifications.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-auto py-1 px-2 text-xs text-destructive hover:text-destructive"
              onClick={handleClearAll}
            >
              Clear all
            </Button>
          )}
        </div>
      </div>
      <ScrollArea className="h-[300px]">
        {isLoading ? (
          <div className="flex items-center justify-center h-20">
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        ) : notifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-muted-foreground">
            <Inbox className="h-8 w-8 mb-2" />
            <p className="text-sm">No notifications yet</p>
          </div>
        ) : (
          <div>
            {notifications.map((notification) => (
              <NotificationItem
                key={notification._id}
                notification={notification}
                onMarkAsRead={handleMarkAsRead}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </PopoverContent>
  );
}
