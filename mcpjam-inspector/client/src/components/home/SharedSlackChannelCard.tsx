import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAction, useQuery } from "convex/react";
import { ExternalLink, Loader2 } from "lucide-react";
import slackMark from "@/assets/slack-mark.png";
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
  // A paid org's automatic onboarding job is queued or running. With no
  // channel yet it means an invite is on its way to the owner; with a channel
  // row, the worker is still handling it, so Retry is hidden. Optional: older
  // backends omit it.
  automaticInvitePending?: boolean;
};

type SharedSlackCardState =
  | SharedSlackChannelStatus
  | "none"
  | "automatic_invite_pending";

// Automation counts a declined or expired invite as done and never sends
// another, so these keep their Retry even while a job is briefly pending.
const AUTOMATION_DONE_STATUSES = new Set(["invite_declined", "invite_expired"]);

// Codes where the backend refuses a manual retry until support reconciles.
const SUPPORT_ONLY_ERROR_CODES = new Set([
  "provision_outcome_unknown",
  "possible_existing_channel",
]);

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

// `retrying`: the automatic worker still owns the row and retries it itself
// (Retry is hidden then). Otherwise the viewer has to retry.
function errorCopy(
  errorCode: string | undefined,
  invitedEmail?: string,
  retrying = false
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
      return "The Slack Connect invite was declined. Free Slack workspaces need to upgrade or start a trial to accept it. Contact support if your Slack is already on a paid plan.";
    case "invite_expired":
      // Automation never resends an expired invite (the backend counts it as
      // done), so this always asks for a new one.
      return "The Slack Connect invite expired. Request a new one.";
    case "provision_outcome_unknown":
      return "We couldn't confirm the shared channel was created. Contact support to finish setting it up.";
    case "invite_outcome_unknown":
      return retrying
        ? "We couldn't confirm Slack sent your invite. Check your email. We'll keep looking for it automatically."
        : "We couldn't confirm Slack sent your invite. Check your email, or retry to look for it again. Retrying won't send a second invite.";
    case "owner_changed":
      return retrying
        ? "Your organization's owner changed during setup. We'll retry and invite the new owner."
        : "Your organization's owner changed during setup. Try again to finish setting it up.";
    case "not_paid":
      return retrying
        ? "Setup paused while your plan was inactive. We'll retry automatically."
        : "Setup stopped because your organization no longer has an active paid plan.";
    case "stale_claim":
      return retrying
        ? "Channel setup was interrupted. We'll retry automatically."
        : "Channel setup was interrupted. Try again.";
    case "rate_limited":
      return retrying
        ? "Slack setup is busy. We'll retry automatically."
        : "Slack setup is busy. Try again in a minute.";
    case "possible_existing_channel":
      return "Your organization may already have a shared Slack channel with MCPJam, so we paused setup to avoid creating a second one. Our team will reach out to connect you.";
    default:
      return retrying
        ? "Could not set up the shared Slack channel. We'll retry automatically."
        : "Could not set up the shared Slack channel. Try again.";
  }
}

function cardState(
  dto: SharedSlackChannelDto | undefined
): SharedSlackCardState {
  if (dto?.channel) return dto.channel.status;
  return dto?.automaticInvitePending ? "automatic_invite_pending" : "none";
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

// Slack's four-color mark (not `/slack_logo.png`, which is Slackbot) on a
// transparent background, so it reads as Slack's own logo.
function SlackMark() {
  return (
    <div className="grid size-6 shrink-0 place-items-center">
      <img src={slackMark} alt="" className="size-5 object-contain" />
    </div>
  );
}

function CardShell({
  children,
  title = "Slack Connect",
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
    if (
      dto.channel === null &&
      !dto.canProvision &&
      !dto.automaticInvitePending
    )
      return;
    const state = cardState(dto);
    const key = `${organizationId}:${state}`;
    if (viewedKey.current === key) return;
    viewedKey.current = key;
    track("home_shared_slack_card_viewed", { location: "home", state });
  }, [enabled, organizationId, dto]);

  const runProvision = useCallback(
    async (kind: "provision" | "retry") => {
      if (!organizationId) return;
      const state = cardState(dto);
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
  // A member can't set anything up, but should still see that an invite is
  // on its way to their owner.
  if (
    dto.channel === null &&
    !dto.canProvision &&
    !dto.automaticInvitePending
  )
    return null;

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

  if (channel === null && dto.automaticInvitePending) {
    // No Set up button: a manual setup here would race the automatic one
    // and invite whoever clicked instead of the owner the email promised.
    return (
      <CardShell>
        <div className="flex items-center gap-2.5 px-4 py-3">
          <SlackMark />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-foreground">
              Your Slack invite is on its way
            </p>
            <p className="text-[11px] text-muted-foreground">
              We&apos;re setting up a Slack Connect channel with the MCPJam
              team. Slack will email the invite to this organization&apos;s
              owner.
            </p>
          </div>
        </div>
      </CardShell>
    );
  }

  if (channel === null) {
    return (
      <CardShell>
        <div className="flex items-center gap-2.5 px-4 py-3">
          <SlackMark />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-foreground">
              Set up Slack Connect with the MCPJam team
            </p>
            <p className="text-[11px] text-muted-foreground">
              Slack sends the invite to your login email. Your Slack admin may
              need to approve it.
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
            Check your email for Slack&apos;s invite.
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
          <SlackMark />
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
              channel.invitedEmail,
              dto.automaticInvitePending
            )}
          </p>
        </div>
        {dto.canManageInvite &&
        (!dto.automaticInvitePending ||
          AUTOMATION_DONE_STATUSES.has(channel.status)) &&
        !SUPPORT_ONLY_ERROR_CODES.has(channel.errorCode ?? "") ? (
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
