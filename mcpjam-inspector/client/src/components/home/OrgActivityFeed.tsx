import { formatDistanceToNow } from "date-fns";
import { Activity } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@mcpjam/design-system/card";

interface ActivityEvent {
  action: string;
  actorEmail: string | null;
  timestamp: number;
  targetType: string;
}

interface OrgActivityFeedProps {
  events: ActivityEvent[];
}

const ACTION_LABELS: Record<string, string> = {
  "server.created": "connected a server",
  "server.updated": "updated a server",
  "project.created": "created a project",
  "chatbox.created": "created a chatbox",
  "user.promoted_from_guest": "joined the team",
  "server.deleted": "removed a server",
  "project.deleted": "deleted a project",
  "member.added": "added a team member",
  "member.removed": "removed a team member",
};

function humanizeAction(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/\./g, " ");
}

function actorLabel(email: string | null): string {
  if (!email) return "Someone";
  return email.split("@")[0];
}

export function OrgActivityFeed({ events }: OrgActivityFeedProps) {
  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Activity className="h-4 w-4 text-muted-foreground" />
          Recent activity
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {events.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-muted-foreground">
            No activity yet — connect a server or create a project to get started.
          </p>
        ) : (
          <ul className="divide-y">
            {events.map((event, i) => (
              <li key={i} className="flex items-start justify-between gap-3 px-5 py-3">
                <p className="text-sm">
                  <span className="font-medium">{actorLabel(event.actorEmail)}</span>{" "}
                  <span className="text-muted-foreground">{humanizeAction(event.action)}</span>
                </p>
                <time className="shrink-0 text-xs text-muted-foreground">
                  {formatDistanceToNow(new Date(event.timestamp), { addSuffix: true })}
                </time>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
