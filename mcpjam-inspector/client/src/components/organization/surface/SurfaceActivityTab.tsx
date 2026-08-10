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
import type { SurfaceKind } from "@/hooks/useOrgSlackSettings";

/**
 * Activity: what the agent proposed, who approved it, and how it went.
 *
 * READ-ONLY, and backed by `auditEvents` rather than the proposals table —
 * that one is swept on a 1-hour TTL and deletes terminal rows, so a feed built
 * on it would lose exactly the outcomes an admin came here to see.
 *
 * The rows carry surface ids (a Slack user id, a Discord user id) and, when
 * the person had linked their account at the time, an MCPJam identity. Both
 * are shown: the email is what a reader recognises, and the surface id is what
 * they can search for when there is no email to show.
 *
 * SURFACE-FILTERED, WHICH IS A FIX AND NOT ONLY A GENERALIZATION. The backing
 * query (`slackAgentActivity:listByOrganization`) matches on
 * `ACTION_PREFIXES = ['slack.agent.', 'discord.agent.']` and always returned
 * both. This tab did no filtering and looked its labels up by the FULL action
 * string, so once #916 started emitting `discord.agent.*` a Discord row landed
 * in the Slack tab rendered as a raw `discord.agent.channel_binding_created`
 * and attributed to "Slack <a discord user id>". Labels are now keyed by the
 * suffix, shared across both surfaces, and each tab shows only its own rows.
 *
 * Filtering is client-side because the query takes no `surfaceKind` argument.
 * Adding one is a backend change, and doing it there would make this PR wait
 * on a backend deploy for a label bug. The cost is that one page can be all
 * one surface, which is why the empty state keeps "Load more" — see below.
 */

/** Keyed by the part after `<surface>.agent.`, so both surfaces share it. */
const ACTION_LABELS: Record<string, string> = {
  proposal_created: "Proposed",
  proposal_executed: "Approved & ran",
  account_linked: "Account connected",
  account_unlinked: "Account disconnected",
  default_project_set: "Default project set",
  channel_binding_created: "Channel bound",
  channel_binding_removed: "Channel unbound",
  capabilities_updated: "Capabilities updated",
};

interface SurfaceActivityCopy {
  /** How the surface is named in prose and in actor labels. */
  label: string;
  /** Where the agent is used, for the empty state. */
  emptyState: string;
}

const SURFACE_COPY: Record<SurfaceKind, SurfaceActivityCopy> = {
  slack: {
    label: "Slack",
    emptyState:
      "Nothing yet. Activity appears here when someone uses the MCPJam agent in Slack — every proposal the agent makes, and every approval that runs one.",
  },
  discord: {
    label: "Discord",
    emptyState:
      "Nothing yet. Activity appears here when someone uses the MCPJam agent in Discord — every proposal the agent makes, and every approval that runs one.",
  },
};

/** `slack.agent.proposal_created` → `proposal_created`. */
function actionSuffix(action: string): string {
  const marker = ".agent.";
  const at = action.indexOf(marker);
  return at === -1 ? action : action.slice(at + marker.length);
}

function readString(
  metadata: Record<string, unknown> | null,
  key: string
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value ? value : null;
}

function actorLabel(
  event: SlackAgentActivityEvent,
  surfaceLabel: string
): string {
  if (event.actorEmail) return event.actorEmail;
  const surfaceId =
    readString(event.metadata, "executorSurfaceUserId") ??
    readString(event.metadata, "proposerSurfaceUserId") ??
    readString(event.metadata, "slackUserId");
  // A surface id with no MCPJam identity is a real state (the legacy
  // workspace runs on a shared key), so it is shown rather than blanked.
  return surfaceId ? `${surfaceLabel} ${surfaceId}` : "MCPJam";
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
  const suffix = actionSuffix(event.action);
  if (suffix === "proposal_created") {
    return { label: "Proposed", variant: "secondary" };
  }
  if (suffix !== "proposal_executed") return null;
  const status = readString(event.metadata, "status");
  if (status === "failed") return { label: "Failed", variant: "destructive" };
  return { label: "Succeeded", variant: "default" };
}

interface SurfaceActivityTabProps {
  organizationId: string;
  surfaceKind: SurfaceKind;
}

export function SurfaceActivityTab({
  organizationId,
  surfaceKind,
}: SurfaceActivityTabProps) {
  const { isAuthenticated } = useConvexAuth();
  const copy = SURFACE_COPY[surfaceKind];
  const {
    events,
    isLoading,
    isLoadingMore,
    hasMore,
    error,
    refresh,
    loadMore,
  } = useSlackAgentActivity({ organizationId, isAuthenticated });

  const rows = useMemo(() => {
    const prefix = `${surfaceKind}.agent.`;
    return events
      .filter((event) => event.action.startsWith(prefix))
      .map((event) => {
        const suffix = actionSuffix(event.action);
        return {
          event,
          suffix,
          // Falls back to the raw action so an action this build has no label
          // for is still legible rather than blank.
          action: ACTION_LABELS[suffix] ?? event.action,
          actor: actorLabel(event, copy.label),
          proposer: readString(event.metadata, "proposerSurfaceUserId"),
          detail: detailLabel(event),
          status: statusFor(event),
          runUrl: readString(event.metadata, "resourceUrl"),
        };
      });
  }, [events, surfaceKind, copy.label]);

  const loadMoreButton = hasMore ? (
    <Button
      variant="outline"
      disabled={isLoadingMore}
      onClick={() => void loadMore()}
    >
      {isLoadingMore ? "Loading…" : "Load more"}
    </Button>
  ) : null;

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
      <div className="space-y-4 px-4 py-8 text-sm text-muted-foreground">
        {/* "Load more" survives the empty state on purpose. Because the feed
            is filtered client-side, a page can be entirely the other surface
            — an org that uses Slack heavily and Discord once would see
            "Nothing yet" on Discord with its one row still a page away.
            Without the button that reads as "no activity", which is wrong. */}
        <p>
          {hasMore
            ? `${copy.emptyState} Older events may be further back.`
            : copy.emptyState}
        </p>
        {loadMoreButton}
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
                    {row.suffix === "proposal_executed" && row.proposer ? (
                      <span className="text-xs text-muted-foreground">
                        proposed by {copy.label} {row.proposer}
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

      {loadMoreButton}
    </div>
  );
}
