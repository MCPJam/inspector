import { useMemo } from "react";
import { useConvexAuth } from "convex/react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@mcpjam/design-system/table";
import {
  useSlackAgentActivity,
  type SlackAgentActivityEvent,
} from "@/hooks/useSlackAgentActivity";

/**
 * Activity: what the agent proposed, who approved it, and how it went.
 *
 * READ-ONLY, and backed by `auditEvents` rather than the proposals table —
 * that one is swept on a 1-hour TTL and deletes terminal rows, so a feed built
 * on it would lose exactly the outcomes an admin came here to see.
 *
 * The rows carry surface ids (a Slack user id) and, when the person had linked
 * their account at the time, an MCPJam identity. Both are shown: the email is
 * what a reader recognises, and the Slack id is what they can search for when
 * there is no email to show.
 */

const ACTION_LABELS: Record<string, string> = {
  "slack.agent.proposal_created": "Proposed",
  "slack.agent.proposal_executed": "Approved & ran",
  "slack.agent.account_linked": "Account connected",
  "slack.agent.account_unlinked": "Account disconnected",
  "slack.agent.default_project_set": "Default project set",
  "slack.agent.channel_binding_created": "Channel bound",
  "slack.agent.channel_binding_removed": "Channel unbound",
  "slack.agent.capabilities_updated": "Capabilities updated",
};

function readString(
  metadata: Record<string, unknown> | null,
  key: string
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value ? value : null;
}

function actorLabel(event: SlackAgentActivityEvent): string {
  if (event.actorEmail) return event.actorEmail;
  const surfaceId =
    readString(event.metadata, "executorSurfaceUserId") ??
    readString(event.metadata, "proposerSurfaceUserId") ??
    readString(event.metadata, "slackUserId");
  // A surface id with no MCPJam identity is a real state (the legacy
  // workspace runs on a shared key), so it is shown rather than blanked.
  return surfaceId ? `Slack ${surfaceId}` : "MCPJam";
}

function detailLabel(event: SlackAgentActivityEvent): string {
  const operation = readString(event.metadata, "operation");
  if (operation) return operation;
  const channelId = readString(event.metadata, "channelId");
  if (channelId) return channelId;
  return event.targetId;
}

function statusFor(
  event: SlackAgentActivityEvent
): { label: string; variant: "default" | "secondary" | "destructive" } | null {
  if (event.action === "slack.agent.proposal_created") {
    return { label: "Proposed", variant: "secondary" };
  }
  if (event.action !== "slack.agent.proposal_executed") return null;
  const status = readString(event.metadata, "status");
  if (status === "failed") return { label: "Failed", variant: "destructive" };
  return { label: "Succeeded", variant: "default" };
}

interface SlackActivityTabProps {
  organizationId: string;
}

export function SlackActivityTab({ organizationId }: SlackActivityTabProps) {
  const { isAuthenticated } = useConvexAuth();
  const {
    events,
    isLoading,
    isLoadingMore,
    hasMore,
    error,
    refresh,
    loadMore,
  } = useSlackAgentActivity({ organizationId, isAuthenticated });

  const rows = useMemo(
    () =>
      events.map((event) => ({
        event,
        action: ACTION_LABELS[event.action] ?? event.action,
        actor: actorLabel(event),
        proposer: readString(event.metadata, "proposerSurfaceUserId"),
        detail: detailLabel(event),
        status: statusFor(event),
        runUrl: readString(event.metadata, "resourceUrl"),
      })),
    [events]
  );

  // Only when there is nothing to show. A failed "Load more" keeps the rows it
  // already has, and replacing the whole feed with an alert would take away
  // what the admin was reading over a transient page fetch — so that case is
  // surfaced beside the button instead, with a retry.
  if (error && rows.length === 0) {
    return (
      <div className="space-y-3">
        <p
          className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          Could not load activity. Try again in a moment.
        </p>
        <Button variant="outline" onClick={() => void refresh()}>
          Try again
        </Button>
      </div>
    );
  }

  if (isLoading && rows.length === 0) {
    return (
      <div className="px-4 py-8 text-sm text-muted-foreground">Loading…</div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="space-y-2 px-4 py-8 text-sm text-muted-foreground">
        <p>
          Nothing yet. Activity appears here when someone uses the MCPJam agent
          in Slack — every proposal the agent makes, and every approval that
          runs one.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Who</TableHead>
              <TableHead>Detail</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Run</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.event._id}
                data-testid={`activity-${row.event.action}`}
              >
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {new Date(row.event.timestamp).toLocaleString()}
                </TableCell>
                <TableCell className="text-sm">{row.action}</TableCell>
                <TableCell className="text-sm">
                  <div className="flex flex-col">
                    <span>{row.actor}</span>
                    {/* Proposing costs nothing; approving spends. When the two
                        are different people, that difference is the whole
                        point of the approval record. */}
                    {row.event.action === "slack.agent.proposal_executed" &&
                    row.proposer ? (
                      <span className="text-xs text-muted-foreground">
                        proposed by Slack {row.proposer}
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {row.detail}
                </TableCell>
                <TableCell>
                  {row.status ? (
                    <Badge variant={row.status.variant}>
                      {row.status.label}
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell>
                  {row.runUrl ? (
                    <a
                      className="text-sm underline underline-offset-2 hover:text-foreground"
                      href={row.runUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open
                    </a>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          Could not load more activity. Try again in a moment.
        </p>
      ) : null}

      {hasMore ? (
        <Button
          variant="outline"
          disabled={isLoadingMore}
          onClick={() => void loadMore()}
        >
          {isLoadingMore ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </div>
  );
}
