import { useState } from "react";
import { Avatar, AvatarFallback } from "@mcpjam/design-system/avatar";
import { Button } from "@mcpjam/design-system/button";
import {
  convexErrorCode,
  type AccessDecision,
  type DecisionResult,
} from "@/components/access-requests/access-request-api";
import {
  outcomeOfJoinDecision,
  outcomeOfRefusal,
} from "@/components/access-requests/access-request-outcome";
import { matchesMember } from "@/components/settings/MemberSearch";
import type { OrganizationAccessRequestRow } from "@/hooks/useWorkOrganizations";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { toast } from "@/lib/toast";
import { getInitials } from "@/lib/utils";
import { ClockPill } from "./ClockPill";

const DAY_MS = 24 * 60 * 60 * 1000;
const DECISION_LABELS = { approve: "Approve", decline: "Decline" } as const;

type Decide = (
  requestId: string,
  decision: AccessDecision,
) => Promise<DecisionResult>;

function requesterLabel(request: OrganizationAccessRequestRow): string {
  return request.name?.trim() ? request.name : request.email;
}

/** "Asked to join today", "yesterday" or "{n} days ago", by calendar day. */
export function askedToJoinWhen(requestedAt: number, now = Date.now()): string {
  const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0);
  const days = Math.round((startOfDay(now) - startOfDay(requestedAt)) / DAY_MS);
  if (days <= 0) return "Asked to join today";
  if (days === 1) return "Asked to join yesterday";
  return `Asked to join ${days} days ago`;
}

type RowProps = { organizationName: string; decide: Decide };

/** Requests follow the member search and show only under "All roles". */
export function joinRequestMatches(
  request: OrganizationAccessRequestRow,
  search: string,
  roleFilter: string,
): boolean {
  return matchesMember(
    { email: request.email, user: { name: request.name } },
    search,
    "requested",
    roleFilter,
  );
}

/**
 * Requests to join, first in the Members & sharing list. Rows sit directly in
 * the list, so they keep their border above the members.
 */
export function JoinRequestRows({
  requests,
  ...rowProps
}: RowProps & { requests: OrganizationAccessRequestRow[] }) {
  return requests.map((request) => (
    <JoinRequestRow key={request.requestId} request={request} {...rowProps} />
  ));
}

function JoinRequestRow({
  request,
  organizationName,
  decide,
}: RowProps & { request: OrganizationAccessRequestRow }) {
  const [deciding, setDeciding] = useState<AccessDecision | null>(null);
  const label = requesterLabel(request);

  // The row leaves the list when the server stops listing it.
  const submit = async (decision: AccessDecision) => {
    setDeciding(decision);
    try {
      const result = await decide(request.requestId, decision);
      const outcome = outcomeOfJoinDecision(label, organizationName, result);
      const settled =
        result.status === "declined" || result.access === "granted";
      (settled ? toast.success : toast.info)(outcome.title, {
        description: outcome.body,
      });
    } catch (error) {
      const refusal = outcomeOfRefusal(convexErrorCode(error));
      if (refusal) {
        toast.error(refusal.title, { description: refusal.body });
      } else {
        toast.error(
          getBillingErrorMessage(
            error,
            "Could not save your decision. Try again.",
            false,
          ),
        );
      }
    } finally {
      setDeciding(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-3 last:border-b-0 hover:bg-muted/30">
      <Avatar className="size-8">
        <AvatarFallback className="text-sm">
          {getInitials(label)}
        </AvatarFallback>
      </Avatar>
      {/* A minimum width, so narrow screens wrap the buttons below the name. */}
      <div className="min-w-48 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-sm font-medium">{label}</p>
          <ClockPill>Requested</ClockPill>
        </div>
        <p className="truncate text-xs text-foreground">
          {request.email} · {askedToJoinWhen(request.requestedAt)}
        </p>
      </div>
      <div className="ml-auto flex items-center gap-3">
        {(["decline", "approve"] as const).map((decision) => (
          <Button
            key={decision}
            type="button"
            variant={decision === "approve" ? "outline" : "ghost"}
            size="sm"
            aria-label={`${DECISION_LABELS[decision]} ${label}`}
            disabled={deciding !== null}
            onClick={() => void submit(decision)}
          >
            {deciding === decision ? "Saving…" : DECISION_LABELS[decision]}
          </Button>
        ))}
      </div>
    </div>
  );
}
