import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAction, useQuery } from "convex/react";
import { ExternalLink, Hash, Loader2 } from "lucide-react";
import { useSharedSlackChannelEnabled } from "@/hooks/useSharedSlackChannelEnabled";
import { track } from "@/lib/analytics";
import { convexErrMessage } from "@/lib/convex-error";
import { toast } from "@/lib/toast";

/**
 * Hand-mirrored DTO from `orgSharedSlackChannels.getForOrganization`.
 * The backend deploys first; the client does not import Convex generated
 * types from mcpjam-backend.
 */
export type SharedSlackChannelStatus =
  | "provisioning"
  | "invite_sent"
  | "pending_admin_approval"
  | "active"
  | "invite_declined"
  | "invite_expired"
  | "error";

export type SharedSlackChannelView = {
  status: SharedSlackChannelStatus;
  inviteExpiresAt?: number;
  invitedEmail?: string;
  channelName?: string;
  openUrl: string | null;
  errorCode?: string;
  inviteUrl?: string;
};

export type SharedSlackChannelDto = {
  channel: SharedSlackChannelView | null;
  canProvision: boolean;
  canManageInvite: boolean;
};

function convexErrCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data: unknown }).data;
    if (data && typeof data === "object" && "code" in data) {
      const code = (data as { code: unknown }).code;
      if (typeof code === "string" && code.trim()) return code;
    }
  }
  return undefined;
}

function formatExpiry(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function errorCopy(
  errorCode: string | undefined,
  invitedEmail?: string
): string {
  switch (errorCode) {
    case "slack_config":
      return "Slack Connect isn't available right now — our team has been notified.";
    case "slack_connect_limit":
      return "This Slack workspace has reached its Slack Connect connection limit.";
    case "invite_email_rejected":
      return invitedEmail
        ? `Slack rejected the invite email (${invitedEmail}).`
        : "Slack rejected the invite email.";
    case "channel_name_conflict":
      return "Could not create a unique shared channel name. Contact support.";
    case "retry_limit":
      return "Too many setup attempts. Contact support to finish this channel.";
    case "provision_in_flight":
      return "Channel setup is already in progress. Try again in a few minutes.";
    case "not_configured":
      return "Slack Connect is not configured on this deployment.";
    case "invite_declined":
      return "The Slack Connect invite was declined. Free Slack workspaces cannot accept Connect invites — contact support if that isn't the case.";
    case "invite_expired":
      return "The Slack Connect invite expired. Request a new one.";
    default:
      return "Could not set up the shared Slack channel. Try again.";
  }
}

function cardState(
  channel: SharedSlackChannelView | null
): SharedSlackChannelStatus | "none" {
  return channel?.status ?? "none";
}

function SharedSlackSkeleton() {
  return (
    <section
      className="rounded-xl border border-border/60"
      aria-busy="true"
      aria-label="Loading shared Slack channel"
    >
      <div className="border-b border-border/60 px-4 py-2">
        <div className="h-3.5 w-40 animate-pulse rounded-sm bg-muted" />
      </div>
      <div className="flex items-center gap-2.5 px-4 py-3">
        <div className="size-6 shrink-0 animate-pulse rounded bg-muted" />
        <div className="h-3.5 w-56 animate-pulse rounded-sm bg-muted" />
      </div>
    </section>
  );
}

function CardShell({
  children,
  title = "Shared Slack channel",
}: {
  children: ReactNode;
  title?: string;
}) {
  return (
    <section className="rounded-xl border border-border/60">
      <div className="border-b border-border/60 px-4 py-2">
        <h2 className="text-[13px] font-medium text-foreground">{title}</h2>
      </div>
      {children}
    </section>
  );
}

/**
 * Home-tab Slack Connect card.
 *
 * Renders purely from the backend DTO (`channel`, `canProvision`,
 * `canManageInvite`). It never discovers the viewer's org role itself.
 * `organizationId` is the home org HomeTab already resolved — the card
 * does not re-derive it.
 */
export function SharedSlackChannelCard({
  organizationId,
}: {
  organizationId: string | null;
}) {
  const enabled = useSharedSlackChannelEnabled();
  const dto = useQuery(
    "orgSharedSlackChannels:getForOrganization" as any,
    enabled && organizationId ? ({ organizationId } as any) : "skip"
  ) as SharedSlackChannelDto | undefined;
  const provision = useAction("orgSharedSlackChannelsNode:provision" as any);
  const refreshStatus = useAction(
    "orgSharedSlackChannelsNode:refreshStatus" as any
  );

  const [busy, setBusy] = useState(false);
  const viewedKey = useRef<string | null>(null);
  const refreshedFor = useRef<string | null>(null);

  const status = dto?.channel?.status;
  useEffect(() => {
    if (!organizationId) return;
    if (status !== "invite_sent" && status !== "pending_admin_approval") {
      return;
    }
    const key = `${organizationId}:${status}`;
    if (refreshedFor.current === key) return;
    refreshedFor.current = key;
    refreshStatus({ organizationId }).catch(() => {
      // Rate-limited / transient — the card keeps current data.
    });
  }, [organizationId, status, refreshStatus]);

  useEffect(() => {
    if (!enabled || !organizationId || dto === undefined) return;
    if (dto.channel === null && !dto.canProvision) return;
    const state = cardState(dto.channel);
    const key = `${organizationId}:${state}`;
    if (viewedKey.current === key) return;
    viewedKey.current = key;
    track("home_shared_slack_card_viewed", { location: "home", state });
  }, [enabled, organizationId, dto]);

  const runProvision = useCallback(
    async (kind: "provision" | "retry") => {
      if (!organizationId) return;
      const state = cardState(dto?.channel ?? null);
      track(
        kind === "retry"
          ? "home_shared_slack_retry_clicked"
          : "home_shared_slack_provision_clicked",
        { location: "home", state }
      );
      setBusy(true);
      try {
        const result = (await provision({ organizationId })) as {
          status?: string;
        };
        if (result?.status === "invite_sent") {
          toast.success(
            dto?.channel?.invitedEmail
              ? `Invite sent to ${dto.channel.invitedEmail}`
              : "Slack Connect invite sent"
          );
        } else if (result?.status === "active") {
          toast.success("Your shared Slack channel is ready");
        }
      } catch (err) {
        toast.error(convexErrMessage(err, errorCopy(convexErrCode(err))));
      } finally {
        setBusy(false);
      }
    },
    [organizationId, dto, provision]
  );

  if (!enabled || !organizationId) return null;
  if (dto === undefined) return <SharedSlackSkeleton />;
  if (dto.channel === null && !dto.canProvision) return null;

  const channel = dto.channel;
  const showSpinner = busy || channel?.status === "provisioning";

  if (showSpinner && (channel === null || channel.status === "provisioning")) {
    return (
      <CardShell>
        <div className="flex items-center gap-2.5 px-4 py-3 text-[13px] text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Setting up your shared Slack channel…
        </div>
      </CardShell>
    );
  }

  if (channel === null) {
    return (
      <CardShell>
        <div className="flex items-center gap-2.5 px-4 py-3">
          <div className="grid size-6 shrink-0 place-items-center rounded bg-muted/60 text-muted-foreground">
            <Hash className="size-3.5" strokeWidth={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-foreground">
              Set up your shared Slack channel
            </p>
            <p className="text-[11px] text-muted-foreground">
              A Slack Connect channel with the MCPJam team, invited to your
              login email.
            </p>
          </div>
          {dto.canProvision ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void runProvision("provision")}
              className="shrink-0 text-[11px] font-medium text-muted-foreground transition hover:text-foreground disabled:opacity-50"
            >
              Set up
            </button>
          ) : null}
        </div>
      </CardShell>
    );
  }

  if (channel.status === "invite_sent") {
    const expiry = channel.inviteExpiresAt
      ? formatExpiry(channel.inviteExpiresAt)
      : null;
    return (
      <CardShell>
        <div className="space-y-2 px-4 py-3">
          <p className="text-[13px] text-foreground">
            Invite sent
            {channel.invitedEmail ? ` to ${channel.invitedEmail}` : ""}
            {expiry ? `, expires ${expiry}` : ""}.
          </p>
          <p className="text-[11px] text-muted-foreground">
            Check your email for Slack&apos;s invite — that is the official
            path. The in-app link is a convenience when we have one.
          </p>
          {channel.inviteUrl ? (
            <a
              href={channel.inviteUrl}
              target="_blank"
              rel="noreferrer"
              onClick={() =>
                track("home_shared_slack_invite_opened", {
                  location: "home",
                  state: "invite_sent",
                })
              }
              className="inline-flex items-center gap-1 text-[11px] font-medium text-foreground hover:underline"
            >
              Accept the invite in Slack
              <ExternalLink className="size-3" />
            </a>
          ) : null}
        </div>
      </CardShell>
    );
  }

  if (channel.status === "pending_admin_approval") {
    return (
      <CardShell>
        <p className="px-4 py-3 text-[13px] text-foreground">
          Waiting on your Slack workspace admin to approve the Connect invite.
        </p>
      </CardShell>
    );
  }

  if (channel.status === "active") {
    return (
      <CardShell>
        <div className="flex items-center gap-2.5 px-4 py-3">
          <div className="grid size-6 shrink-0 place-items-center rounded bg-muted/60 text-muted-foreground">
            <Hash className="size-3.5" strokeWidth={1.75} />
          </div>
          <p className="min-w-0 flex-1 truncate text-[13px] text-foreground">
            {channel.channelName
              ? `#${channel.channelName}`
              : "Your shared Slack channel"}
          </p>
          {channel.openUrl ? (
            <a
              href={channel.openUrl}
              target="_blank"
              rel="noreferrer"
              onClick={() =>
                track("home_shared_slack_channel_opened", {
                  location: "home",
                  state: "active",
                })
              }
              className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-muted-foreground transition hover:text-foreground"
            >
              Open your shared Slack channel
              <ExternalLink className="size-3" />
            </a>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              Shared channel is connected
            </span>
          )}
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell>
      <div className="flex items-start gap-2.5 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-foreground">
            {errorCopy(
              channel.errorCode ?? channel.status,
              channel.invitedEmail
            )}
          </p>
        </div>
        {dto.canManageInvite ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void runProvision("retry")}
            className="shrink-0 text-[11px] font-medium text-muted-foreground transition hover:text-foreground disabled:opacity-50"
          >
            Retry
          </button>
        ) : null}
      </div>
    </CardShell>
  );
}
