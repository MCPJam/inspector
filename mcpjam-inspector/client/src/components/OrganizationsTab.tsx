import { SettingsPageDescription } from "@/components/settings/SettingsPageDescription";
import { DataManagementSettings, PermissionGroupsDialog, enterpriseContactHref } from "./organization/EnterpriseSettings";
import { Badge } from "@mcpjam/design-system/badge";
import { ApiKeysRoute } from "./settings/ApiKeysRoute";
import { DeleteOrganizationDialog } from "./organization/DeleteOrganizationDialog";
import {
  MemberSearch,
  MemberListHeader,
  matchesMember,
} from "./settings/MemberSearch";
import { OrganizationGeneralDetails } from "./organization/OrganizationGeneralDetails";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { permalinkSignInOptions } from "@/lib/permalink-signin-return";
import { useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
import {
  Building2,
  CreditCard,
  Loader2,
  LogOut,
  LockKeyhole,
  RefreshCw,
  Trash2,
  UserPlus,
} from "lucide-react";
import { toast } from "@/lib/toast";
import {
  Card,
  CardContent,
  CardHeader,
} from "@mcpjam/design-system/card";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import {
  Organization,
  OrganizationMember,
  type OrganizationMembershipRole,
  resolveOrganizationRole,
  useOrganizationQueries,
  useOrganizationMembers,
  useOrganizationMutations,
} from "@/hooks/useOrganizations";
import {
  useOrganizationBilling,
  type BillingInterval,
  type OrganizationBillingStatus,
  type OrganizationSeatPaymentIntent,
  type OrganizationPlan,
} from "@/hooks/useOrganizationBilling";
import {
  formatPlanName,
  getBillingErrorMessage,
  isGateAccessDenied,
} from "@/lib/billing-entitlements";
import type { CheckoutIntentWithOrganization } from "@/lib/billing-deep-link";
import type { OrganizationRouteSection } from "@/lib/app-navigation";
import { SettingsPageShell } from "@/components/settings/SettingsPageShell";
import { SettingsStatePanel } from "@/components/settings/SettingsStatePanel";
import { BILLING_GATES, resolveBillingGateState } from "@/lib/billing-gates";
import {
  getBillingUpsellCtaLabel,
  getBillingUpsellTeaser,
} from "@/lib/billing-upsell";
import { OrganizationAuditLog } from "./organization/OrganizationAuditLog";
import { OrganizationSharingPolicyCard } from "./organization/OrganizationSharingPolicyCard";
import { OrganizationBillingSection } from "./organization/OrganizationBillingSection";
import { OrganizationCurrentPlanPanel } from "./organization/OrganizationCurrentPlanPanel";
import { OrganizationMemberRow } from "./organization/OrganizationMemberRow";
import { OrganizationModelsSection } from "./organization/OrganizationModelsSection";
import {
  resolveSlackSettingsTab,
  SlackAgentSettingsSection,
  type SlackSettingsTabId,
} from "./organization/slack/SlackAgentSettingsSection";
import {
  DiscordAgentSettingsSection,
  resolveDiscordSettingsTab,
  type DiscordSettingsTabId,
} from "./organization/discord/DiscordAgentSettingsSection";
import { useSlackAgentSettingsEnabled } from "@/hooks/useSlackAgentSettingsEnabled";
import { useDiscordAgentEnabled } from "@/hooks/useDiscordAgentEnabled";
import { useTraceDestinationsEnabled } from "@/hooks/useTraceDestinationsEnabled";
import { TraceDestinationsSection } from "./organization/observability/TraceDestinationsSection";
import { OrganizationSpendBudgetSection } from "./organization/OrganizationSpendBudgetSection";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import {
  useAppNavigate,
  useCurrentSearchParam,
  buildOrganizationPath,
} from "@/lib/app-navigation";
import { captureAppSignInReturnPath } from "@/lib/app-signin-return-path";

interface OrganizationsTabProps {
  organizationId?: string;
  section?: OrganizationRouteSection;
  children?: ReactNode;
  checkoutIntent?: CheckoutIntentWithOrganization | null;
  onCheckoutIntentConsumed?: () => void;
  onCheckoutIntentNavigationStarted?: () => void;
  navigateBillingInSameTab?: (url: string) => void;
  onOrganizationDeleted?: (organizationId: string) => void;
}

interface PendingDowngradeConfirmation {
  targetPlan: "free";
  targetBillingInterval: BillingInterval | null;
  currentPlan: OrganizationPlan;
  currentBillingInterval: BillingInterval | null;
}

interface ScheduledBillingChangeCancellationState {
  ctaLabel: string;
  confirmLabel: string;
  dialogTitle: string;
  dialogDescription: string;
  successMessage: string;
}

function formatBillingDate(timestampMs: number | null): string | null {
  if (timestampMs == null) {
    return null;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestampMs));
}

function formatBillingIntervalLabel(interval: BillingInterval): string {
  return interval === "annual" ? "annual" : "monthly";
}

function formatPlanDescriptor(
  plan: OrganizationPlan,
  billingInterval: BillingInterval | null,
): string {
  if (billingInterval == null) {
    return formatPlanName(plan);
  }

  return `${formatPlanName(plan)} ${formatBillingIntervalLabel(
    billingInterval,
  )}`;
}

function getScheduledBillingChangeCancellationState(
  billingStatus: OrganizationBillingStatus | undefined,
): ScheduledBillingChangeCancellationState | null {
  if (
    !billingStatus?.canManageBilling ||
    !billingStatus.canCancelScheduledBillingChange ||
    billingStatus.stripeCancelAtPeriodEnd
  ) {
    return null;
  }

  const currentPlan = billingStatus.plan;
  const currentBillingInterval = billingStatus.billingInterval;
  const scheduledPlan = billingStatus.stripeScheduledPlan;
  const scheduledBillingInterval = billingStatus.stripeScheduledBillingInterval;

  if (
    currentPlan !== "team" ||
    currentBillingInterval == null ||
    scheduledPlan == null ||
    scheduledBillingInterval == null
  ) {
    return null;
  }

  if (
    scheduledPlan === currentPlan &&
    scheduledBillingInterval === currentBillingInterval
  ) {
    return null;
  }

  const currentIntervalLabel = formatBillingIntervalLabel(
    currentBillingInterval,
  );
  const scheduledIntervalLabel = formatBillingIntervalLabel(
    scheduledBillingInterval,
  );
  const currentPlanName = formatPlanName(currentPlan);
  const effectiveDate = formatBillingDate(
    billingStatus.stripeScheduledEffectiveAt,
  );
  const keepCurrentPlanLabel = `Keep ${currentPlanName} ${currentIntervalLabel} plan`;
  const effectiveDateSuffix = effectiveDate ? ` on ${effectiveDate}` : "";
  const scheduledDescriptor =
    scheduledPlan === currentPlan
      ? `${scheduledIntervalLabel} billing`
      : `${formatPlanName(scheduledPlan)} ${scheduledIntervalLabel}`;
  const changeNoun = scheduledPlan === currentPlan ? "switch" : "change";

  return {
    ctaLabel: keepCurrentPlanLabel,
    confirmLabel: keepCurrentPlanLabel,
    dialogTitle: `${keepCurrentPlanLabel}?`,
    dialogDescription: `This cancels the pending ${changeNoun} to ${scheduledDescriptor}${effectiveDateSuffix}. ${currentPlanName} ${currentIntervalLabel} remains active.`,
    successMessage: `Scheduled billing change canceled. ${currentPlanName} ${currentIntervalLabel} remains active.`,
  };
}

function PendingSeatPaymentNotice({
  intent,
  isFinishingSeatPayment,
  isCompletingSeatPayment,
  isCancelingSeatPayment,
  onFinish,
  onCancel,
}: {
  intent: OrganizationSeatPaymentIntent;
  isFinishingSeatPayment: boolean;
  isCompletingSeatPayment: boolean;
  isCancelingSeatPayment: boolean;
  onFinish: () => void;
  onCancel: () => void;
}) {
  const needsRetry = intent.needsRetry === true;
  const cleanupPending = intent.status === "cleanup_pending";

  return (
    <Alert
      className={
        needsRetry
          ? "border-destructive/30 bg-destructive/[0.04]"
          : "border-primary/20 bg-primary/[0.04]"
      }
      data-testid={
        needsRetry
          ? "failed-seat-payment-notice"
          : "pending-seat-payment-notice"
      }
    >
      <CreditCard
        className={
          needsRetry ? "size-4 text-destructive" : "size-4 text-primary"
        }
      />
      <AlertTitle>
        {needsRetry
          ? "Seat payment didn't go through"
          : "Seat payment required"}
      </AlertTitle>
      <AlertDescription className="space-y-3">
        <p>
          {cleanupPending ? (
            <>
              Stripe is closing {intent.email}'s declined invoice. Retry will
              unlock as soon as cleanup is confirmed.
            </>
          ) : needsRetry ? (
            <>
              We couldn't charge for {intent.email}'s seat. They won't get
              access or credits until it's paid.
            </>
          ) : (
            <>
              Finish payment to add {intent.email}. They will not get access or
              credits until payment succeeds.
            </>
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            onClick={onFinish}
            disabled={
              cleanupPending || isFinishingSeatPayment || isCancelingSeatPayment
            }
          >
            {cleanupPending || isFinishingSeatPayment ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <CreditCard className="mr-2 size-4" />
            )}
            {needsRetry ? "Retry payment" : "Finish payment"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onCancel}
            disabled={isCompletingSeatPayment || isCancelingSeatPayment}
          >
            {isCancelingSeatPayment ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : null}
            {needsRetry ? "Remove invite" : "Cancel"}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

// Shared leave-organization logic used by both the access-restricted screen and
// the settings danger zone, so removal rules and error handling stay in sync.
function useLeaveOrganization(organization: Organization) {
  const appNavigate = useAppNavigate();
  const { user } = useAuth();
  const { removeMember } = useOrganizationMutations();
  const currentUserEmail = user?.email;

  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);

  const handleLeave = async () => {
    if (!currentUserEmail) return;

    setIsLeaving(true);
    try {
      await removeMember({
        organizationId: organization._id,
        email: currentUserEmail,
      });
      toast.success("You have left the organization");
      setLeaveConfirmOpen(false);
      appNavigate("/servers");
    } catch (error) {
      toast.error((error as Error).message || "Failed to leave organization");
    } finally {
      setIsLeaving(false);
    }
  };

  return { leaveConfirmOpen, setLeaveConfirmOpen, isLeaving, handleLeave };
}

function LeaveOrganizationDialog({
  organizationName,
  open,
  onOpenChange,
  isLeaving,
  onConfirm,
}: {
  organizationName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isLeaving: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Leave Organization?</AlertDialogTitle>
          <AlertDialogDescription>
            You will lose access to "{organizationName}". You'll need to be
            re-invited to rejoin.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLeaving}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            // Keep the dialog open while the request is in flight; it closes
            // on success (via handleLeave) or stays open to surface errors.
            onClick={(event) => {
              event.preventDefault();
              void onConfirm();
            }}
            disabled={isLeaving}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isLeaving ? "Leaving..." : "Leave Organization"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function OrganizationAccessRestricted({
  organization,
}: {
  organization: Organization;
}) {
  const appNavigate = useAppNavigate();
  const { leaveConfirmOpen, setLeaveConfirmOpen, isLeaving, handleLeave } =
    useLeaveOrganization(organization);

  // A member without admin rights is still ON the Organization section, so the
  // tab stays and stays current — they just cannot manage what is behind it.
  // Losing the shell here left them with no route to the other Settings
  // sections at all.
  return (
    <OrganizationStateShell organizationId={organization._id}>
      <Building2 className="size-8 text-muted-foreground/50" aria-hidden />
      <h2 className="text-lg font-semibold">Access restricted</h2>
      <p className="max-w-prose text-sm text-muted-foreground">
        You don't have permission to view organization settings. Contact an
        admin or owner for access.
      </p>
      <div className="flex flex-col items-center gap-3">
        <Button variant="outline" onClick={() => appNavigate("/servers")}>
          Go to Servers
        </Button>
        <button
          type="button"
          onClick={() => setLeaveConfirmOpen(true)}
          className="rounded-sm text-sm text-muted-foreground outline-none transition-colors hover:text-destructive focus-visible:ring-1 focus-visible:ring-ring"
        >
          Leave organization
        </button>
      </div>

      <LeaveOrganizationDialog
        organizationName={organization.name}
        open={leaveConfirmOpen}
        onOpenChange={setLeaveConfirmOpen}
        isLeaving={isLeaving}
        onConfirm={handleLeave}
      />
    </OrganizationStateShell>
  );
}

/**
 * The org page's pre-content states — still a Settings section, so they keep
 * the shell. Rendering them bare used to strand the user: signing out and
 * clicking Organization replaced the whole page, tab strip included, with a
 * lone sign-in button and no way back to the other sections.
 *
 * `organizationId` is what the Organization tab would point at, so it is passed
 * only when this org is real and reachable — not for a deleted or bogus id.
 */
function OrganizationStateShell({
  children,
}: {
  organizationId?: string | null;
  children: ReactNode;
}) {
  return (
    <SettingsPageShell>
      <SettingsStatePanel>{children}</SettingsStatePanel>
    </SettingsPageShell>
  );
}

export function OrganizationsTab({
  organizationId,
  section = "overview",
  children,
  checkoutIntent = null,
  onCheckoutIntentConsumed,
  onCheckoutIntentNavigationStarted,
  navigateBillingInSameTab,
  onOrganizationDeleted,
}: OrganizationsTabProps) {
  const appNavigate = useAppNavigate();
  const { user, signIn } = useAuth();
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();

  const { sortedOrganizations, isLoading } = useOrganizationQueries({
    isAuthenticated,
  });

  // Find the organization by ID
  const organization = organizationId
    ? sortedOrganizations.find((org) => org._id === organizationId)
    : null;

  if (isAuthLoading) {
    return (
      <OrganizationStateShell organizationId={organizationId}>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <RefreshCw className="size-4 animate-spin" />
          Completing sign-in...
        </div>
      </OrganizationStateShell>
    );
  }

  if (!user || !isAuthenticated) {
    return (
      <OrganizationStateShell organizationId={organizationId}>
        <h2 className="text-lg font-semibold">
          Sign in to manage organizations
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          Members, models, and billing live on your organization. Sign in to
          manage them.
        </p>
        <Button
          onClick={() => {
            // Remember where they were, so WorkOS returns them here rather
            // than to the app's front door.
            captureAppSignInReturnPath();
            signIn(permalinkSignInOptions());
          }}
        >
          Sign in
        </Button>
      </OrganizationStateShell>
    );
  }

  if (isLoading) {
    return (
      <OrganizationStateShell organizationId={organizationId}>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <RefreshCw className="size-4 animate-spin" />
          Loading organization...
        </div>
      </OrganizationStateShell>
    );
  }

  if (!organization) {
    return (
      <OrganizationStateShell>
        <Building2 className="size-8 text-muted-foreground/50" aria-hidden />
        <h2 className="text-lg font-semibold">Organization not found</h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          This organization may have been deleted or you don't have access to
          it.
        </p>
        <Button variant="outline" onClick={() => appNavigate("/servers")}>
          Go to Servers
        </Button>
      </OrganizationStateShell>
    );
  }

  const myRole = organization.myRole;
  const hasAccess = myRole === "owner" || myRole === "admin";

  if (!hasAccess && !children) {
    return <OrganizationAccessRestricted organization={organization} />;
  }

  return (
    <OrganizationPage
      organization={organization}
      section={section}
      children={children}
      checkoutIntent={
        checkoutIntent?.organizationId === organization._id
          ? checkoutIntent
          : null
      }
      onCheckoutIntentConsumed={onCheckoutIntentConsumed}
      onCheckoutIntentNavigationStarted={onCheckoutIntentNavigationStarted}
      navigateBillingInSameTab={navigateBillingInSameTab}
      onOrganizationDeleted={onOrganizationDeleted}
    />
  );
}

interface OrganizationPageProps {
  organization: Organization;
  section: OrganizationRouteSection;
  children?: ReactNode;
  checkoutIntent?: CheckoutIntentWithOrganization | null;
  onCheckoutIntentConsumed?: () => void;
  onCheckoutIntentNavigationStarted?: () => void;
  navigateBillingInSameTab?: (url: string) => void;
  onOrganizationDeleted?: (organizationId: string) => void;
}

interface CheckoutNavigationOptions {
  navigation?: "new-tab" | "same-tab";
  onBeforeNavigate?: () => void;
}

function OrganizationPage({
  organization,
  section,
  children,
  checkoutIntent = null,
  onCheckoutIntentConsumed,
  onCheckoutIntentNavigationStarted,
  navigateBillingInSameTab,
  onOrganizationDeleted,
}: OrganizationPageProps) {
  const appNavigate = useAppNavigate();
  const { isAuthenticated } = useConvexAuth();
  const { user } = useAuth();
  const currentUserEmail = user?.email;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    activeMembers,
    pendingMembers,
    isLoading: membersLoading,
  } = useOrganizationMembers({
    isAuthenticated,
    organizationId: organization._id,
  });

  const {
    updateOrganization,
    deleteOrganization,
    addMember,
    changeMemberRole,
    transferOrganizationOwnership,
    removeMember,
    generateLogoUploadUrl,
    updateOrganizationLogo,
  } = useOrganizationMutations();

  const currentMember = activeMembers.find(
    (m) => m.email.toLowerCase() === currentUserEmail?.toLowerCase(),
  );
  const currentRole: OrganizationMembershipRole | null = currentMember
    ? resolveOrganizationRole(currentMember)
    : null;
  const isOwner = currentRole === "owner";
  const canEdit = currentRole === "owner" || currentRole === "admin";
  const canInvite = canEdit;
  const {
    billingStatus,
    organizationPremiumness,
    planCatalog,
    isLoadingBilling,
    isLoadingEntitlements,
    isLoadingPlanCatalog,
    isLoadingOrganizationPremiumness,
    isStartingPlanChange,
    pendingPlanChangeTarget,
    isOpeningPortal,
    isCancelingScheduledBillingChange,
    activeSeatPaymentIntent,
    isFinishingSeatPayment,
    isCompletingSeatPayment,
    isCancelingSeatPayment,
    isHandlingSeatPayment,
    error: billingError,
    startPlanChange,
    openPortal,
    openCancellationPortal,
    openIntervalChangePortal,
    cancelScheduledBillingChange,
    finishSeatPayment,
    retrySeatPayment,
    cancelSeatPayment,
  } = useOrganizationBilling(organization._id, {
    enabled: isAuthenticated,
    includeSeatPaymentIntent: true,
  });
  const billingEntitlementsUiEnabled = useFeatureFlagEnabled(
    "billing-entitlements-ui",
  );
  const billingUiEnabled = billingEntitlementsUiEnabled === true;
  const slackAgentSettingsEnabled = useSlackAgentSettingsEnabled();
  const discordAgentEnabled = useDiscordAgentEnabled();
  // The client flag decides whether to ADVERTISE the section. The section
  // itself re-checks the server's answer, which is the one that governs
  // access; see the hook's docblock for why this component cannot ask.
  const traceDestinationsEnabled = useTraceDestinationsEnabled();
  // One `?tab=` param, read once and resolved per section — each resolver
  // falls back to its own Connections, so a Slack tab id in a Discord URL
  // lands somewhere real instead of on a blank panel.
  const rawSurfaceTab = useCurrentSearchParam("tab");
  const activeSection: OrganizationRouteSection =
    section === "api-keys" || section === "plans" || section === "data-management"
      ? section
      : section === "models"
        ? "models"
        : section === "billing" || section === "budget"
          ? "billing"
          : // Flag OFF collapses the Slack section back to the overview rather
            // than rendering an empty page: a user who kept the URL from a
            // flagged-in session should land somewhere real.
            section === "slack" && slackAgentSettingsEnabled
            ? "slack"
            : // Same collapse for Discord, and it matters more here: the agent is
              // dark, so nearly everyone hitting this URL is flagged OFF.
              section === "discord" && discordAgentEnabled
              ? "discord"
              : // Same collapse again for Observability.
                section === "observability" && traceDestinationsEnabled
                ? "observability"
                : section === "members" || section === "sharing"
                  ? "members"
                  : section === "audit-log"
                    ? section
                    : "overview";
  // The sub-tab lives in `?tab=` — views of one settings section, not separate
  // org routes. Read from the URL rather than component state so a link to a
  // specific tab works, and through the router's location context so switching
  // tabs actually re-renders.
  const slackTab: SlackSettingsTabId = resolveSlackSettingsTab(rawSurfaceTab);
  const discordTab: DiscordSettingsTabId =
    resolveDiscordSettingsTab(rawSurfaceTab);
  const memberInviteGate = resolveBillingGateState({
    billingUiEnabled,
    organizationId: organization._id,
    billingStatus,
    premiumness: organizationPremiumness,
    gate: BILLING_GATES.memberInvites,
    isLoading:
      billingUiEnabled &&
      (isLoadingBilling || isLoadingOrganizationPremiumness),
  });
  const memberUpsellTeaser = getBillingUpsellTeaser({
    planCatalog,
    upgradePlan: memberInviteGate.upgradePlan,
    intent: "members",
  });
  const memberUpsellCtaLabel = getBillingUpsellCtaLabel(
    memberInviteGate.upgradePlan,
  );

  const canRemoveMember = (member: OrganizationMember): boolean => {
    if (!currentRole) return false;
    const isSelf =
      member.email.toLowerCase() === currentUserEmail?.toLowerCase();
    if (isSelf) return false;

    const targetRole = resolveOrganizationRole(member);
    if (currentRole === "owner") {
      return targetRole !== "owner";
    }
    if (currentRole === "admin") {
      return targetRole === "member";
    }
    return false;
  };

  const canRemovePendingMember = (): boolean => {
    if (!currentRole) return false;
    return currentRole === "owner" || currentRole === "admin";
  };

  // Logo upload state
  const [isUploadingLogo, setIsUploadingLogo] = useState(false);

  // Invite state
  const [inviteEmail, setInviteEmail] = useState("");
  const [isInviting, setIsInviting] = useState(false);
  const [roleUpdatingEmail, setRoleUpdatingEmail] = useState<string | null>(
    null,
  );
  const [transferTargetMember, setTransferTargetMember] =
    useState<OrganizationMember | null>(null);
  const [isTransferringOwnership, setIsTransferringOwnership] = useState(false);

  // Delete/Leave state
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const { leaveConfirmOpen, setLeaveConfirmOpen, isLeaving, handleLeave } =
    useLeaveOrganization(organization);
  const [
    scheduledBillingChangeConfirmOpen,
    setScheduledBillingChangeConfirmOpen,
  ] = useState(false);
  const [pendingDowngradeConfirmation, setPendingDowngradeConfirmation] =
    useState<PendingDowngradeConfirmation | null>(null);
  const scheduledBillingChangeCancellation =
    getScheduledBillingChangeCancellationState(billingStatus);

  const [memberSearch, setMemberSearch] = useState("");
  const [memberRoleFilter, setMemberRoleFilter] = useState("all");
  const handleLogoClick = () => {
    if (canEdit) {
      fileInputRef.current?.click();
    }
  };

  const handleLogoFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith("image/")) {
      toast.error("Please select an image file");
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image must be less than 5MB");
      return;
    }

    setIsUploadingLogo(true);

    try {
      // Get upload URL from Convex
      const uploadUrl = await generateLogoUploadUrl({
        organizationId: organization._id,
      });

      // Upload file to Convex storage
      const result = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });

      if (!result.ok) {
        throw new Error("Failed to upload file");
      }

      const { storageId } = await result.json();

      // Update organization's logo in database
      await updateOrganizationLogo({
        organizationId: organization._id,
        storageId,
      });
    } catch (error) {
      console.error("Failed to upload logo:", error);
      toast.error("Failed to upload logo. Please try again.");
    } finally {
      setIsUploadingLogo(false);
      // Reset input so the same file can be selected again
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleInvite = async () => {
    if (!inviteEmail.trim() || !canInvite) return;
    if (memberInviteGate.isLoading) {
      return;
    }
    if (memberInviteGate.isDenied) {
      toast.error(
        memberInviteGate.denialMessage ??
          "Upgrade required to add more members",
      );
      return;
    }
    const email = inviteEmail.trim();
    setIsInviting(true);
    try {
      const result = await addMember({
        organizationId: organization._id,
        email,
      });
      if (result.needsSeatPayment) {
        setInviteEmail("");
        await handleFinishSeatPayment(result.seatPaymentIntentId, email);
        return;
      }
      if (result.isPending) {
        toast.success(
          `Invitation sent to ${email}. They'll get access once they sign up.`,
        );
      } else {
        toast.success(`${email} added to the organization.`);
      }
      setInviteEmail("");
    } catch (error) {
      toast.error(
        getBillingErrorMessage(
          error,
          "Failed to invite member",
          billingStatus?.canManageBilling ?? false,
        ),
      );
    } finally {
      setIsInviting(false);
    }
  };

  const handleFinishSeatPayment = async (
    seatPaymentIntentId?: string,
    email?: string,
  ) => {
    try {
      const result = await finishSeatPayment(seatPaymentIntentId);
      if (result.status === "paid") {
        toast.success(
          `${
            email ?? activeSeatPaymentIntent?.email ?? "Member"
          } added to the organization.`,
        );
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Payment was not completed. The member was not added.",
      );
    }
  };

  const seatInviteRemovalInFlightRef = useRef(false);
  const [isRemovingSeatInvite, setIsRemovingSeatInvite] = useState(false);

  const handleRetrySeatPayment = async () => {
    if (activeSeatPaymentIntent?.status === "cleanup_pending") return;
    try {
      const result = await retrySeatPayment();
      if (result?.status === "paid") {
        toast.success(
          `${
            activeSeatPaymentIntent?.email ?? "Member"
          } added to the organization.`,
        );
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Payment was not completed. The member was not added.",
      );
    }
  };

  const handleCancelSeatPayment = async () => {
    // For a terminal charge the button says "Remove invite", and that is what
    // it has to do: cancelSeatPayment returns immediately for anything not
    // still active, so calling it here left the invite and the notice exactly
    // where they were while claiming success.
    const isInviteRemoval = activeSeatPaymentIntent?.needsRetry === true;
    // Removal has no spinner of its own — the shared one belongs to
    // cancelSeatPayment, which this path never calls — so a second click would
    // fire a concurrent removeMember that finds no row and reports "Member not
    // found" on top of the first one's success. The state below disables the
    // button and is what normally prevents that; the ref keeps the handler
    // self-guarding rather than depending on its own button being disabled.
    if (isInviteRemoval) {
      if (seatInviteRemovalInFlightRef.current) return;
      seatInviteRemovalInFlightRef.current = true;
      setIsRemovingSeatInvite(true);
    }
    try {
      if (isInviteRemoval && activeSeatPaymentIntent) {
        await removeMember({
          organizationId: organization._id,
          email: activeSeatPaymentIntent.email,
        });
        toast.success(`Invite for ${activeSeatPaymentIntent.email} removed.`);
        return;
      }
      const result = await cancelSeatPayment();
      if (result.outcome === "canceled") {
        toast.success("Pending seat payment canceled.");
      } else if (result.outcome === "deferred") {
        toast.error(
          "Stripe could not confirm cancellation yet. The payment is still pending; try again.",
        );
      } else if (result.outcome === "paid") {
        toast.success(
          "Payment completed before cancellation; the member was added.",
        );
      } else {
        toast.error("This seat payment is no longer active.");
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to cancel pending seat payment",
      );
    } finally {
      if (isInviteRemoval) {
        seatInviteRemovalInFlightRef.current = false;
        setIsRemovingSeatInvite(false);
      }
    }
  };

  const [memberToRemove, setMemberToRemove] = useState<{ email: string; pending: boolean } | null>(null);
  const [isRemovingMember, setIsRemovingMember] = useState(false);
  const removingMemberRef = useRef(false);
  const [removeMemberError, setRemoveMemberError] = useState("");
  const requestMemberRemoval = (email: string, pending = false) => {
    setRemoveMemberError("");
    setMemberToRemove({ email, pending });
  };

  const handleRemoveMember = async () => {
    if (!memberToRemove || removingMemberRef.current) return;
    removingMemberRef.current = true;
    setIsRemovingMember(true);
    setRemoveMemberError("");
    try {
      await removeMember({
        organizationId: organization._id,
        email: memberToRemove.email,
      });
      toast.success(memberToRemove.pending ? "Invitation canceled" : "Member removed");
      setMemberToRemove(null);
    } catch (error) {
      setRemoveMemberError(getBillingErrorMessage(
        error,
        "Could not remove this member. Please try again.",
        billingStatus?.canManageBilling ?? false,
      ));
    } finally {
      removingMemberRef.current = false;
      setIsRemovingMember(false);
    }
  };

  const handleChangeMemberRole = async (
    member: OrganizationMember,
    role: "admin" | "member" | "guest",
  ) => {
    if (!isOwner) return;

    const currentTargetRole = resolveOrganizationRole(member);
    if (currentTargetRole === "owner" || currentTargetRole === role) {
      return;
    }

    setRoleUpdatingEmail(member.email);
    try {
      await changeMemberRole({
        organizationId: organization._id,
        email: member.email,
        role,
      });
      toast.success(`Updated role for ${member.email}`);
    } catch (error) {
      toast.error((error as Error).message || "Failed to update member role");
    } finally {
      setRoleUpdatingEmail(null);
    }
  };

  const handleTransferOwnership = async () => {
    if (!isOwner || !transferTargetMember) return;

    setIsTransferringOwnership(true);
    try {
      const result = (await transferOrganizationOwnership({
        organizationId: organization._id,
        newOwnerEmail: transferTargetMember.email,
      })) as { changed?: boolean } | undefined;

      if (result?.changed === false) {
        toast.success("Ownership is already assigned to that member");
      } else {
        toast.success(`Ownership transferred to ${transferTargetMember.email}`);
      }

      setTransferTargetMember(null);
    } catch (error) {
      toast.error(
        (error as Error).message || "Failed to transfer organization ownership",
      );
    } finally {
      setIsTransferringOwnership(false);
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await deleteOrganization({ organizationId: organization._id });
      toast.success("Organization deleted");
      setDeleteConfirmOpen(false);
      onOrganizationDeleted?.(organization._id);
      if (!onOrganizationDeleted) {
        appNavigate("/servers");
      }
    } catch (error) {
      toast.error((error as Error).message || "Failed to delete organization");
    } finally {
      setIsDeleting(false);
    }
  };

  const auditLogLocked =
    billingUiEnabled && isGateAccessDenied(organizationPremiumness, "auditLog");
  const navigateToSection = (nextSection: OrganizationRouteSection) => {
    appNavigate(buildOrganizationPath(organization._id, nextSection));
  };
  const navigateToSlackTab = (tab: SlackSettingsTabId) => {
    appNavigate(
      `${buildOrganizationPath(organization._id, "slack")}?tab=${tab}`,
    );
  };
  const navigateToDiscordTab = (tab: DiscordSettingsTabId) => {
    appNavigate(
      `${buildOrganizationPath(organization._id, "discord")}?tab=${tab}`,
    );
  };
  const handleViewBilling = () => navigateToSection("billing");

  const openBillingUrl = useCallback(
    (url: string, navigation: "new-tab" | "same-tab" = "new-tab") => {
      if (navigation === "same-tab") {
        (
          navigateBillingInSameTab ??
          ((nextUrl: string) => window.location.assign(nextUrl))
        )(url);
        return;
      }

      window.open(url, "_blank", "noopener,noreferrer");
    },
    [navigateBillingInSameTab],
  );

  const getBillingReturnUrl = useCallback(
    () =>
      `${window.location.origin}${buildOrganizationPath(
        organization._id,
        "billing",
      )}`,
    [organization._id],
  );

  const handleManageBilling = async () => {
    try {
      const billingUrl = await openPortal(getBillingReturnUrl());
      openBillingUrl(billingUrl);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to open billing portal",
      );
    }
  };

  const handleChangeBillingInterval = async (
    targetBillingInterval: BillingInterval,
  ) => {
    try {
      const billingUrl = await openIntervalChangePortal(
        getBillingReturnUrl(),
        targetBillingInterval,
      );
      openBillingUrl(billingUrl);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to open billing interval change",
      );
    }
  };

  const handleDowngradePlan = async (
    targetPlan: OrganizationPlan,
    _targetBillingInterval: BillingInterval,
  ) => {
    const currentPlan = billingStatus?.plan;

    if (currentPlan === "team" && targetPlan === "free" && billingStatus) {
      setPendingDowngradeConfirmation({
        targetPlan: "free",
        targetBillingInterval: null,
        currentPlan,
        currentBillingInterval: billingStatus.billingInterval,
      });
      return;
    }

    await handleManageBilling();
  };

  const handleOpenScheduledBillingChangeCancelDialog = () => {
    if (!scheduledBillingChangeCancellation) return;
    setScheduledBillingChangeConfirmOpen(true);
  };

  const handleConfirmScheduledBillingChangeCancellation = async () => {
    if (!scheduledBillingChangeCancellation) return;

    try {
      await cancelScheduledBillingChange();
      setScheduledBillingChangeConfirmOpen(false);
      toast.success(scheduledBillingChangeCancellation.successMessage);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to cancel scheduled billing change",
      );
    }
  };

  const handleConfirmDowngrade = async () => {
    if (!pendingDowngradeConfirmation) return;

    try {
      // Only path is targetPlan === "free": send the user to the Stripe
      // cancellation portal. Paid-tier downgrades no longer exist.
      const billingUrl = await openCancellationPortal(getBillingReturnUrl());
      openBillingUrl(billingUrl);
      setPendingDowngradeConfirmation(null);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to change plan",
      );
    }
  };

  const executeManualPlanChange = async (
    tier: "team",
    billingInterval: "monthly" | "annual",
    options: CheckoutNavigationOptions = {},
  ) => {
    try {
      const result = await startPlanChange(
        getBillingReturnUrl(),
        tier,
        billingInterval,
        { confirmPaidPlanChange: true },
      );

      if (result.kind === "updated") {
        toast.success(
          `Plan updated to ${formatPlanName(
            result.subscription.plan ?? tier,
          )}.`,
        );
        return;
      }

      if (result.kind === "scheduled") {
        toast.success("Plan change scheduled for renewal.");
        return;
      }

      const billingUrl =
        result.kind === "checkout" ? result.checkoutUrl : result.portalUrl;
      options.onBeforeNavigate?.();
      openBillingUrl(billingUrl, options.navigation);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to change plan",
      );
    }
  };

  const handlePlanChange = async (
    tier: "team",
    billingInterval: "monthly" | "annual",
    options: CheckoutNavigationOptions = {},
  ) => {
    await executeManualPlanChange(tier, billingInterval, options);
  };

  const pendingDowngradeEffectiveDate = formatBillingDate(
    billingStatus?.stripeCurrentPeriodEnd ?? null,
  );
  const pendingDowngradeTargetLabel = pendingDowngradeConfirmation
    ? formatPlanDescriptor(
        pendingDowngradeConfirmation.targetPlan,
        pendingDowngradeConfirmation.targetBillingInterval,
      )
    : null;
  const pendingDowngradeCurrentLabel = pendingDowngradeConfirmation
    ? formatPlanDescriptor(
        pendingDowngradeConfirmation.currentPlan,
        pendingDowngradeConfirmation.currentBillingInterval,
      )
    : null;

  const handleAutoPlanChange = useCallback(
    async (tier: "team", billingInterval: "monthly" | "annual") => {
      try {
        const result = await startPlanChange(
          getBillingReturnUrl(),
          tier,
          billingInterval,
          { confirmPaidPlanChange: false },
        );

        if (result.kind === "updated") {
          toast.success(
            `Plan updated to ${formatPlanName(
              result.subscription.plan ?? tier,
            )}.`,
          );
          return;
        }

        if (result.kind === "scheduled") {
          toast.success("Plan change scheduled for renewal.");
          return;
        }

        const billingUrl =
          result.kind === "checkout" ? result.checkoutUrl : result.portalUrl;
        onCheckoutIntentNavigationStarted?.();
        openBillingUrl(billingUrl, "same-tab");
      } catch (error) {
        if (!(
          error instanceof Error &&
          error.message === PAID_PLAN_CHANGE_CONFIRMATION_REQUIRED_MESSAGE
        )) {
          toast.error(
            error instanceof Error ? error.message : "Failed to change plan",
          );
        }
        throw error;
      }
    },
    [
      getBillingReturnUrl,
      onCheckoutIntentNavigationStarted,
      openBillingUrl,
      startPlanChange,
    ],
  );

  const pendingSeatPaymentNotice =
    activeSeatPaymentIntent && billingStatus?.canManageBilling ? (
      <PendingSeatPaymentNotice
        intent={activeSeatPaymentIntent}
        isFinishingSeatPayment={isFinishingSeatPayment}
        isCompletingSeatPayment={isCompletingSeatPayment}
        isCancelingSeatPayment={isCancelingSeatPayment || isRemovingSeatInvite}
        onFinish={() =>
          void (activeSeatPaymentIntent.needsRetry
            ? handleRetrySeatPayment()
            : handleFinishSeatPayment())
        }
        onCancel={() => void handleCancelSeatPayment()}
      />
    ) : null;

  return (
    <SettingsPageShell>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleLogoFileChange}
      />
      {activeSection === "overview" && !children ? (
        <OrganizationGeneralDetails
          key={organization._id}
          organizationId={organization._id}
          name={organization.name}
          logoUrl={organization.logoUrl}
          canEdit={canEdit}
          isUploading={isUploadingLogo}
          onUpload={handleLogoClick}
          onSave={(name) =>
            updateOrganization({ organizationId: organization._id, name })
          }
        />
      ) : null}

      {(activeSection === "billing" || activeSection === "plans") &&
        !children && (
          <header className="space-y-1">
            <h1 className="text-2xl font-semibold text-accent-foreground">
              {activeSection === "plans" ? "Plans" : "Usage & billing"}
            </h1>
            <SettingsPageDescription>
              {activeSection === "plans"
                ? "Compare plans and manage your subscription."
                : "Review usage, manage credits, and update your billing details."}
            </SettingsPageDescription>
          </header>
        )}

      {children ??
        (activeSection === "api-keys" ? (
          <ApiKeysRoute organizationId={organization._id} />
        ) : activeSection === "models" ? (
          <OrganizationModelsSection
            organizationId={organization._id}
            isAdmin={canEdit}
          />
        ) : activeSection === "slack" ? (
          <SlackAgentSettingsSection
            organizationId={organization._id}
            isAdmin={canEdit}
            tab={slackTab}
            onTabChange={navigateToSlackTab}
          />
        ) : activeSection === "discord" ? (
          <DiscordAgentSettingsSection
            organizationId={organization._id}
            isAdmin={canEdit}
            tab={discordTab}
            onTabChange={navigateToDiscordTab}
          />
        ) : activeSection === "observability" ? (
          <ErrorBoundary name="organization_observability">
            <TraceDestinationsSection
              organizationId={organization._id}
              isAdmin={canEdit}
            />
          </ErrorBoundary>
        ) : activeSection === "billing" || activeSection === "plans" ? (
          <>
            {pendingSeatPaymentNotice}
            <OrganizationBillingSection
              organizationId={organization._id}
              showPlanBilling={billingUiEnabled}
              showCredits={activeSection === "billing"}
              showPlanComparison={activeSection === "plans"}
              billingStatus={billingStatus}
              organizationName={organization.name}
              canManageCredits={canEdit || organization.isCreator === true}
              planCatalog={planCatalog}
              isLoadingBilling={isLoadingBilling}
              isLoadingPlanCatalog={isLoadingPlanCatalog}
              isStartingPlanChange={isStartingPlanChange}
              pendingPlanChangeTarget={pendingPlanChangeTarget}
              isOpeningPortal={isOpeningPortal}
              onDowngradePlan={handleDowngradePlan}
              onStartPlanChange={handlePlanChange}
              onStartAutoPlanChange={handleAutoPlanChange}
              checkoutIntent={checkoutIntent}
              onCheckoutIntentConsumed={onCheckoutIntentConsumed}
              spendBudgetPanel={
                activeSection === "billing" &&
                organization.isPersonal !== true ? (
                  <ErrorBoundary name="organization_spend_budget">
                    <div id="setting-spend-budget">
                      <OrganizationSpendBudgetSection
                        organizationId={organization._id}
                        isAdmin={canEdit}
                      />
                    </div>
                  </ErrorBoundary>
                ) : null
              }
              currentPlanPanel={
                billingUiEnabled ? (
                  <Card className="gap-3 border-0 bg-transparent py-0 shadow-none">
                    {activeSection !== "plans" ? (
                      <CardHeader className="flex flex-row items-center justify-between gap-3 p-0">
                        <h2 className="text-lg font-semibold">Current plan</h2>
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto p-0"
                          onClick={() => navigateToSection("plans")}
                        >
                          Compare plans
                        </Button>
                      </CardHeader>
                    ) : null}
                    <CardContent className="space-y-3 p-0">
                      {isLoadingBilling ? (
                        <div className="rounded-md border border-dashed border-border/70 p-3 text-sm text-muted-foreground">
                          Loading billing details...
                        </div>
                      ) : billingStatus && !billingStatus.billingConfigured ? (
                        <div className="rounded-md border border-dashed border-border/70 p-3 text-sm text-muted-foreground">
                          Billing is not configured in this environment.
                        </div>
                      ) : billingStatus ? (
                        <>
                          <OrganizationCurrentPlanPanel
                            billingStatus={billingStatus}
                            planCatalog={planCatalog}
                            isLoadingPlanCatalog={isLoadingPlanCatalog}
                            onChangeBillingInterval={
                              handleChangeBillingInterval
                            }
                            onCancelScheduledBillingChange={
                              scheduledBillingChangeCancellation
                                ? handleOpenScheduledBillingChangeCancelDialog
                                : undefined
                            }
                            cancelScheduledBillingChangeLabel={
                              scheduledBillingChangeCancellation?.ctaLabel ??
                              null
                            }
                            onManageBilling={handleManageBilling}
                            isOpeningPortal={isOpeningPortal}
                          />
                          {!billingStatus.canManageBilling ? (
                            <p className="min-w-0 text-sm font-medium text-primary">
                              Only organization owners can manage billing.
                            </p>
                          ) : null}
                        </>
                      ) : null}
                    </CardContent>
                  </Card>
                ) : null
              }
            />
            {billingError ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                {billingError}
              </div>
            ) : null}
          </>
        ) : (
          <>
            {activeSection === "members" && (
              <Card className="gap-4 border-0 bg-transparent py-0 shadow-none">
                <CardHeader className="px-0">
                  <h1 className="text-2xl font-semibold text-accent-foreground">
                    Members & sharing
                  </h1>
                  <SettingsPageDescription>
                    Manage organization members, roles, invitations, and sharing
                    access.
                  </SettingsPageDescription>
                </CardHeader>
                <CardContent className="space-y-4 p-0">
                  {canInvite ? (
                    <div className="space-y-3">
                      {pendingSeatPaymentNotice}
                      <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
                        <Input
                          placeholder="Email address"
                          value={inviteEmail}
                          onChange={(e) => setInviteEmail(e.target.value)}
                          onKeyDown={(e) =>
                            e.key === "Enter" && void handleInvite()
                          }
                          className="h-9 w-full sm:w-80"
                        />
                        <Button
                          size="sm"
                          className="h-9"
                          onClick={handleInvite}
                          disabled={
                            !inviteEmail.trim() ||
                            isInviting ||
                            isHandlingSeatPayment ||
                            memberInviteGate.isLoading ||
                            memberInviteGate.isDenied
                          }
                        >
                          <UserPlus className="mr-2 size-4" />
                          {isInviting || isHandlingSeatPayment
                            ? "Working..."
                            : "Add member"}
                        </Button>
                      </div>

                      {billingStatus?.plan &&
                      planCatalog?.plans[billingStatus.plan]?.billingModel ===
                        "per_seat" ? (
                        <p className="text-xs text-muted-foreground">
                          Pending invites are free. You'll be billed for this
                          seat once the invite is accepted.
                        </p>
                      ) : null}

                      {memberInviteGate.isDenied ? (
                        <Alert
                          className="border-primary/20 bg-primary/[0.04]"
                          data-testid="member-limit-upsell"
                        >
                          <CreditCard className="size-4 text-primary" />
                          <AlertTitle>Need more members?</AlertTitle>
                          <AlertDescription className="gap-2">
                            {memberInviteGate.denialMessage ? (
                              <p>{memberInviteGate.denialMessage}</p>
                            ) : null}
                            {memberUpsellTeaser ? (
                              <p className="text-foreground/80">
                                {memberUpsellTeaser}
                              </p>
                            ) : null}
                            {billingStatus?.canManageBilling ? (
                              <Button
                                type="button"
                                size="sm"
                                className="mt-1"
                                onClick={handleViewBilling}
                              >
                                {memberUpsellCtaLabel}
                              </Button>
                            ) : (
                              <p className="font-medium text-foreground/80">
                                Ask an organization owner to review billing
                                options.
                              </p>
                            )}
                          </AlertDescription>
                        </Alert>
                      ) : null}
                    </div>
                  ) : null}

                  <MemberSearch
                    query={memberSearch}
                    onQueryChange={setMemberSearch}
                    role={memberRoleFilter}
                    onRoleChange={setMemberRoleFilter}
                    roles={["owner", "admin", "member", "guest", "pending"]}
                    actions={<PermissionGroupsDialog enterprise={billingStatus?.effectivePlan === "enterprise"} />}
                  />
                  <div className="overflow-hidden rounded-lg border border-border">
                    <MemberListHeader
                      activeCount={membersLoading ? undefined : activeMembers.length}
                      pendingCount={pendingMembers.length}
                    />
                    {membersLoading ? (
                      <div className="flex items-center gap-2 py-3 text-muted-foreground">
                        <RefreshCw className="size-4 animate-spin" />
                        Loading members...
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {activeMembers
                          .filter((member) =>
                            matchesMember(
                              member,
                              memberSearch,
                              resolveOrganizationRole(member),
                              memberRoleFilter,
                            ),
                          )
                          .map((member) => {
                            const memberRole = resolveOrganizationRole(member);
                            return (
                              <OrganizationMemberRow
                                key={member._id}
                                member={member}
                                role={memberRole}
                                currentUserEmail={currentUserEmail}
                                canEditRole={isOwner && memberRole !== "owner"}
                                isRoleUpdating={
                                  roleUpdatingEmail === member.email
                                }
                                onRoleChange={
                                  isOwner && memberRole !== "owner"
                                    ? (role) =>
                                        void handleChangeMemberRole(
                                          member,
                                          role,
                                        )
                                    : undefined
                                }
                                onTransferOwnership={
                                  isOwner && memberRole !== "owner"
                                    ? () => setTransferTargetMember(member)
                                    : undefined
                                }
                                isTransferringOwnership={
                                  isTransferringOwnership &&
                                  transferTargetMember?.email === member.email
                                }
                                onRemove={
                                  canRemoveMember(member)
                                    ? () => requestMemberRemoval(member.email)
                                    : undefined
                                }
                              />
                            );
                          })}
                      </div>
                    )}

                    {pendingMembers.length > 0 ? (
                      <div className="space-y-1 pt-2">
                        {pendingMembers
                          .filter((member) =>
                            matchesMember(
                              member,
                              memberSearch,
                              "pending",
                              memberRoleFilter,
                            ),
                          )
                          .map((member) => (
                            <OrganizationMemberRow
                              key={member._id}
                              member={member}
                              currentUserEmail={currentUserEmail}
                              isPending
                              onRemove={
                                canRemovePendingMember()
                                  ? () => requestMemberRemoval(member.email, true)
                                  : undefined
                              }
                            />
                          ))}
                      </div>
                    ) : null}
                    {!membersLoading &&
                      ![...activeMembers, ...pendingMembers].some((member) =>
                        matchesMember(
                          member,
                          memberSearch,
                          pendingMembers.includes(member)
                            ? "pending"
                            : resolveOrganizationRole(member),
                          memberRoleFilter,
                        ),
                      ) && (
                        <p
                          role="status"
                          className="p-6 text-center text-sm text-foreground"
                        >
                          No members found.
                        </p>
                      )}
                  </div>
                </CardContent>
              </Card>
            )}
            {activeSection === "members" && (
              <div className="border-t border-border pt-5">
                <OrganizationSharingPolicyCard
                  organizationId={organization._id}
                  isAdmin={canEdit}
                />
              </div>
            )}

            {activeSection === "data-management" && <DataManagementSettings enterprise={billingStatus?.effectivePlan === "enterprise"} />}
            {activeSection === "audit-log" && (
              <section className="space-y-8">
                <header className="space-y-1">
                  <div className="flex items-center gap-3">
                    <h1 className="text-2xl font-semibold text-accent-foreground">Audit log</h1>
                    <Badge variant="secondary" className="text-xs uppercase tracking-wide">Enterprise</Badge>
                  </div>
                  <SettingsPageDescription>
                    Review organization activity and export it as CSV.
                  </SettingsPageDescription>
                </header>
                <div className="space-y-3">
                  {billingUiEnabled &&
                  (isLoadingEntitlements ||
                    isLoadingOrganizationPremiumness) ? (
                    <div className="rounded-md border border-dashed border-border/70 p-3 text-sm text-muted-foreground">
                      Loading audit log access...
                    </div>
                  ) : auditLogLocked ? (
                    <div className="flex min-h-56 flex-col items-center justify-center gap-5 rounded-lg border border-border bg-muted/20 px-6 py-10 text-center">
                      <LockKeyhole aria-hidden="true" className="size-7 text-muted-foreground" />
                      <p className="text-base text-muted-foreground">Audit logs are available on Enterprise plans.</p>
                      {billingUiEnabled ? (
                        <Button asChild><a href={enterpriseContactHref}>Contact us</a></Button>
                      ) : null}
                      {!billingStatus?.canManageBilling ? (
                        <p className="text-xs text-muted-foreground">Ask an organization owner to upgrade your plan.</p>
                      ) : null}
                    </div>
                  ) : (
                    <OrganizationAuditLog
                      organizationId={organization._id}
                      organizationName={organization.name}
                      isAuthenticated={isAuthenticated}
                    />
                  )}
                </div>
              </section>
            )}
            {activeSection === "overview" && (
              <section className="max-w-2xl space-y-4 border-t border-border pt-7">
                <h2 className="text-lg font-semibold text-accent-foreground">
                  Danger Zone
                </h2>
                {!membersLoading && (
                  <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-destructive/40 p-4">
                    <div className="min-w-0 flex-1 space-y-1">
                      <h3 className="text-sm font-semibold text-accent-foreground">
                        {isOwner ? "Delete organization" : "Leave organization"}
                      </h3>
                      <p className="text-sm text-foreground">
                        {isOwner
                          ? "Permanently delete this organization. This action cannot be undone."
                          : "You’ll lose access to this organization and its projects."}
                      </p>
                    </div>
                    <Button
                      variant={isOwner ? "destructive" : "outline"}
                      onClick={() =>
                        isOwner
                          ? setDeleteConfirmOpen(true)
                          : setLeaveConfirmOpen(true)
                      }
                    >
                      {isOwner ? (
                        <Trash2 aria-hidden="true" className="size-4" />
                      ) : (
                        <LogOut aria-hidden="true" className="size-4" />
                      )}
                      {isOwner ? "Delete Organization" : "Leave Organization"}
                    </Button>
                  </div>
                )}
              </section>
            )}
          </>
        ))}

      {/* Ownership Transfer Confirmation */}
      <AlertDialog
        open={!!memberToRemove}
        onOpenChange={(open) => {
          if (!open && !removingMemberRef.current) setMemberToRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {memberToRemove?.pending ? "Cancel invitation?" : "Remove member?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {memberToRemove?.pending
                ? `Cancel the invitation for ${memberToRemove.email} to join ${organization.name}?`
                : `Remove ${memberToRemove?.email ?? "this member"} from ${organization.name}? They will lose their organization membership and the access it grants. You can invite them again later.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removeMemberError && <p role="alert" className="text-sm text-destructive">{removeMemberError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRemovingMember}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={isRemovingMember}
              onClick={() => void handleRemoveMember()}
            >
              {isRemovingMember ? "Removing…" : memberToRemove?.pending ? "Cancel invitation" : "Remove member"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!transferTargetMember}
        onOpenChange={(open) => {
          if (!open && !isTransferringOwnership) {
            setTransferTargetMember(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Transfer organization ownership?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {transferTargetMember
                ? `You are about to transfer ownership of "${organization.name}" to ${transferTargetMember.email}. You will become an admin.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isTransferringOwnership}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleTransferOwnership();
              }}
              disabled={isTransferringOwnership}
            >
              {isTransferringOwnership
                ? "Transferring..."
                : "Transfer ownership"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={scheduledBillingChangeConfirmOpen}
        onOpenChange={(open) => {
          if (!open && !isCancelingScheduledBillingChange) {
            setScheduledBillingChangeConfirmOpen(false);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {scheduledBillingChangeCancellation?.dialogTitle ??
                "Cancel scheduled billing change?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {scheduledBillingChangeCancellation?.dialogDescription ??
                "This cancels the pending billing change and keeps the current subscription active."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isCancelingScheduledBillingChange}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleConfirmScheduledBillingChangeCancellation();
              }}
              disabled={isCancelingScheduledBillingChange}
            >
              {isCancelingScheduledBillingChange
                ? "Saving..."
                : (scheduledBillingChangeCancellation?.confirmLabel ??
                  "Keep current plan")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingDowngradeConfirmation !== null}
        onOpenChange={(open) => {
          if (!open && !isStartingPlanChange && !isOpeningPortal) {
            setPendingDowngradeConfirmation(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDowngradeConfirmation?.targetPlan === "free"
                ? "Return to Free at renewal?"
                : "Downgrade to Team?"}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              {pendingDowngradeConfirmation?.targetPlan === "free" ? (
                <>
                  <span className="block">
                    This cancellation takes effect at renewal, not now.{" "}
                    {pendingDowngradeCurrentLabel ?? "Your paid plan"} remains
                    active until{" "}
                    {pendingDowngradeEffectiveDate ??
                      "the end of the current billing period"}
                    , after which the organization returns to Free.
                  </span>
                  <span className="block">
                    Once cancellation is scheduled, you can't change your
                    billing interval (monthly or annual) until you reactivate.
                  </span>
                </>
              ) : (
                <span className="block">
                  This downgrade takes effect at renewal, not now.{" "}
                  {pendingDowngradeTargetLabel ?? "Team"} begins{" "}
                  {pendingDowngradeEffectiveDate ??
                    "at the end of the current billing period"}
                  , and {pendingDowngradeCurrentLabel ?? "your current plan"}{" "}
                  remains active until then.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isStartingPlanChange || isOpeningPortal}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleConfirmDowngrade();
              }}
              disabled={isStartingPlanChange || isOpeningPortal}
            >
              {isStartingPlanChange || isOpeningPortal
                ? "Saving..."
                : pendingDowngradeConfirmation?.targetPlan === "free"
                  ? "Open cancellation flow"
                  : "Schedule downgrade"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Confirmation */}
      <DeleteOrganizationDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        name={organization.name}
        pending={isDeleting}
        onConfirm={handleDelete}
      />

      {/* Leave Confirmation */}
      <LeaveOrganizationDialog
        organizationName={organization.name}
        open={leaveConfirmOpen}
        onOpenChange={setLeaveConfirmOpen}
        isLeaving={isLeaving}
        onConfirm={handleLeave}
      />
    </SettingsPageShell>
  );
}
const PAID_PLAN_CHANGE_CONFIRMATION_REQUIRED_MESSAGE =
  "Paid plan changes require an explicit confirmation.";
