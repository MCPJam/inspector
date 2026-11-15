import { useState, type ReactNode } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { AutoTopupDialog } from "./AutoTopupDialogBody";
import { CreditTopupDialog } from "./CreditTopupDialog";
import { RequestUpgradeButton } from "./RequestUpgradeButton";
import { TopupActionButton } from "./TopupActionButton";
import { useAutoTopup } from "@/hooks/useAutoTopup";
import { useCreditBalance } from "@/hooks/useCreditBalance";
import {
  canManageOrgCredits,
  useOrganizationQueries,
} from "@/hooks/useOrganizations";
import { useUpgradeRequestRecipients } from "@/hooks/use-upgrade-request-recipients";
import { readStoredActiveOrganizationId } from "@/lib/active-organization-storage";
import { buildOrganizationPath, useAppNavigate } from "@/lib/app-navigation";
import { PLATFORM_FEE_HEADLINE } from "@/lib/platform-fee-refusal";

/** `loading` until the viewer's role in the organization is known. */
export type PlatformFeeAudience = "manager" | "member" | "loading";

export interface PlatformFeeRefusalViewProps {
  audience: PlatformFeeAudience;
  /** False on a plan that cannot buy top-ups, where credits come with a plan. */
  topUpEligible: boolean;
  autoReloadOn: boolean;
  onBuyCredits: () => void;
  onAutoReload: () => void;
  onComparePlans: () => void;
  /** A member's way to reach the owners; renders nothing without one. */
  memberRequest?: ReactNode;
}

function bodyFor({
  audience,
  topUpEligible,
  autoReloadOn,
}: PlatformFeeRefusalViewProps): string {
  if (audience === "member")
    return "Ask an owner or admin to buy credits or turn on auto-reload, then run it again.";
  if (audience === "manager" && !topUpEligible)
    return "Compare plans to add credits, then run it again.";
  if (audience === "manager" && autoReloadOn)
    return "Buy credits, then run it again. Auto-reload is already on.";
  return "Buy credits or turn on auto-reload, then run it again.";
}

/**
 * What a run refused over the platform fee offers. Buying credits leads and
 * auto-reload sits beside it; neither replaces the other. A provider key is
 * never offered: the customer already brings one, and it does not pay the fee.
 */
export function PlatformFeeRefusalView(props: PlatformFeeRefusalViewProps) {
  const { audience, topUpEligible, autoReloadOn, memberRequest } = props;
  return (
    <section
      role="alert"
      aria-label="Not enough credits"
      className="space-y-3 border-l-2 border-warning pl-4"
      data-testid="platform-fee-refusal"
    >
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          {PLATFORM_FEE_HEADLINE}
        </p>
        <p className="text-sm text-muted-foreground">{bodyFor(props)}</p>
      </div>
      {audience === "manager" && !topUpEligible && (
        <Button type="button" size="sm" onClick={props.onComparePlans}>
          Compare plans
        </Button>
      )}
      {audience === "manager" && topUpEligible && (
        <div className="flex flex-wrap items-center gap-2">
          <ErrorBoundary
            name="platform_fee_topup_button"
            fallback={
              <span className="text-xs text-muted-foreground">
                Top up unavailable
              </span>
            }
          >
            <TopupActionButton onClick={props.onBuyCredits} />
          </ErrorBoundary>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={props.onAutoReload}
          >
            {autoReloadOn ? "Manage auto-reload" : "Turn on auto-reload"}
          </Button>
        </div>
      )}
      {audience === "member" && memberRequest}
    </section>
  );
}

type ViewWithoutAutoReload = Omit<PlatformFeeRefusalViewProps, "autoReloadOn">;

/** Reads auto-reload apart so its query failing costs only the label. */
function ManagerView({
  organizationId,
  ...props
}: ViewWithoutAutoReload & { organizationId: string }) {
  const { view } = useAutoTopup(organizationId);
  return (
    <PlatformFeeRefusalView
      {...props}
      autoReloadOn={view?.status === "enrolled"}
    />
  );
}

/**
 * The refusal for the active organization, with its dialogs. Pass
 * `organizationId` when the surface knows the run's organization.
 */
export function PlatformFeeRefusal({
  organizationId: organizationIdProp,
}: {
  organizationId?: string | null;
}) {
  const navigate = useAppNavigate();
  const { user } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const { sortedOrganizations, isLoading } = useOrganizationQueries({
    isAuthenticated,
  });
  const organizationId =
    organizationIdProp ??
    (user ? readStoredActiveOrganizationId(user.id) : undefined) ??
    null;
  const organization =
    sortedOrganizations.find((org) => org._id === organizationId) ?? null;
  const audience: PlatformFeeAudience =
    !organization || isLoading
      ? "loading"
      : canManageOrgCredits(organization)
        ? "manager"
        : "member";
  const { balance } = useCreditBalance({ organizationId });
  const { recipients } = useUpgradeRequestRecipients(
    audience === "member" ? organizationId : null,
  );
  const [dialog, setDialog] = useState<"topup" | "autoReload" | null>(null);

  const props: ViewWithoutAutoReload = {
    audience,
    topUpEligible: balance?.topUpEligible !== false,
    onBuyCredits: () => setDialog("topup"),
    onAutoReload: () => setDialog("autoReload"),
    onComparePlans: () => {
      if (organizationId)
        navigate(buildOrganizationPath(organizationId, "plans"));
    },
    memberRequest: (
      <RequestUpgradeButton
        recipients={recipients}
        organizationName={organization?.name ?? "your organization"}
        teamName="Team"
        origin="credits"
        limitKind="credits"
        requestAction="buyCredits"
        organizationId={organizationId}
      />
    ),
  };
  const manager = audience === "manager" && organizationId;

  return (
    <>
      {manager ? (
        <ErrorBoundary
          name="platform_fee_auto_reload"
          fallback={<PlatformFeeRefusalView {...props} autoReloadOn={false} />}
        >
          <ManagerView {...props} organizationId={organizationId} />
        </ErrorBoundary>
      ) : (
        <PlatformFeeRefusalView {...props} autoReloadOn={false} />
      )}
      {manager && dialog === "topup" && (
        <CreditTopupDialog
          open
          onOpenChange={(open) => setDialog(open ? "topup" : null)}
          chatSessionId=""
          lastUserMessage=""
          organizationId={organizationId}
          organizationName={organization?.name}
          source="eval_platform_fee"
        />
      )}
      {manager && (
        <AutoTopupDialog
          open={dialog === "autoReload"}
          onOpenChange={(open) => setDialog(open ? "autoReload" : null)}
          organizationId={organizationId}
          canManage
        />
      )}
    </>
  );
}
