import { useCallback, useRef, useState } from "react";
import { useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { EditableText } from "@/components/ui/editable-text";
import { Avatar, AvatarFallback, AvatarImage } from "@mcpjam/design-system/avatar";
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
  AlertTriangle,
  Building2,
  Camera,
  CreditCard,
  Loader2,
  LogOut,
  RefreshCw,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@mcpjam/design-system/card";
import { Alert, AlertDescription, AlertTitle } from "@mcpjam/design-system/alert";
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
  type OrganizationPlan,
  type PlanCatalog,
} from "@/hooks/useOrganizationBilling";
import {
  formatPlanName,
  getBillingErrorMessage,
  isGateAccessDenied,
} from "@/lib/billing-entitlements";
import type { CheckoutIntentWithOrganization } from "@/lib/billing-deep-link";
import type { OrganizationRouteSection } from "@/lib/hosted-navigation";
import { BILLING_GATES, resolveBillingGateState } from "@/lib/billing-gates";
import {
  getBillingUpsellCtaLabel,
  getBillingUpsellTeaser,
} from "@/lib/billing-upsell";
import { cn } from "@/lib/utils";
import { OrganizationAuditLog } from "./organization/OrganizationAuditLog";
import { OrganizationBillingSection } from "./organization/OrganizationBillingSection";
import { OrganizationCurrentPlanPanel } from "./organization/OrganizationCurrentPlanPanel";
import { OrganizationMemberRow } from "./organization/OrganizationMemberRow";
import { OrganizationModelsSection } from "./organization/OrganizationModelsSection";

interface OrganizationsTabProps {
  organizationId?: string;
  section?: OrganizationRouteSection;
  checkoutIntent?: CheckoutIntentWithOrganization | null;
  onCheckoutIntentConsumed?: () => void;
  onCheckoutIntentNavigationStarted?: () => void;
  navigateBillingInSameTab?: (url: string) => void;
  onOrganizationDeleted?: (organizationId: string) => void;
}

function getOrganizationRouteHash(
  organizationId: string,
  section: OrganizationRouteSection,
): string {
  if (section === "billing") return `organizations/${organizationId}/billing`;
  if (section === "models") return `organizations/${organizationId}/models`;
  return `organizations/${organizationId}`;
}

interface PendingPaidUpgradeConfirmation {
  tier: "team";
  billingInterval: BillingInterval;
}

interface PendingDowngradeConfirmation {
  targetPlan: "free" | "starter";
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

function shouldConfirmPaidUpgrade(
  billingStatus: OrganizationBillingStatus | undefined,
  tier: "starter" | "team",
): boolean {
  return (
    tier === "team" &&
    billingStatus?.plan === "starter" &&
    (billingStatus.subscriptionStatus === "active" ||
      billingStatus.subscriptionStatus === "trialing")
  );
}

function formatCurrencyAmount(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
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

  return `${formatPlanName(plan)} ${formatBillingIntervalLabel(billingInterval)}`;
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
    (currentPlan !== "starter" && currentPlan !== "team") ||
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

function getPaidUpgradeConfirmationSummary(
  planCatalog: PlanCatalog | undefined,
  billingInterval: BillingInterval,
): string {
  const teamPlan = planCatalog?.plans.team;
  const seatMinimum = teamPlan?.seatMinimum ?? 4;
  const priceCents = teamPlan?.prices[billingInterval];

  if (typeof priceCents !== "number") {
    return billingInterval === "annual"
      ? `Team with annual billing (${seatMinimum}-seat minimum)`
      : `Team with monthly billing (${seatMinimum}-seat minimum)`;
  }

  const billedAmount = (priceCents * seatMinimum) / 100;
  const cadence = billingInterval === "annual" ? "year" : "month";
  const currency = planCatalog?.currency ?? "usd";

  return `Team at ${formatCurrencyAmount(billedAmount, currency)}/${cadence} (${seatMinimum}-seat minimum)`;
}

export function OrganizationsTab({
  organizationId,
  section = "overview",
  checkoutIntent = null,
  onCheckoutIntentConsumed,
  onCheckoutIntentNavigationStarted,
  navigateBillingInSameTab,
  onOrganizationDeleted,
}: OrganizationsTabProps) {
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
      <div className="flex flex-col items-center justify-center h-full p-8">
        <div className="flex items-center gap-2 text-muted-foreground">
          <RefreshCw className="size-4 animate-spin" />
          Completing sign-in...
        </div>
      </div>
    );
  }

  if (!user || !isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <div className="text-center space-y-4 max-w-md">
          <h2 className="text-2xl font-bold">
            Sign in to manage organizations
          </h2>
          <Button onClick={() => signIn()} size="lg">
            Sign In
          </Button>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <div className="flex items-center gap-2 text-muted-foreground">
          <RefreshCw className="size-4 animate-spin" />
          Loading organization...
        </div>
      </div>
    );
  }

  if (!organization) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <div className="text-center space-y-4 max-w-md">
          <Building2 className="size-12 text-muted-foreground/50 mx-auto" />
          <h2 className="text-2xl font-bold">Organization not found</h2>
          <p className="text-muted-foreground">
            This organization may have been deleted or you don't have access to
            it.
          </p>
          <Button onClick={() => (window.location.hash = "servers")}>
            Go to Servers
          </Button>
        </div>
      </div>
    );
  }

  const myRole = organization.myRole;
  const hasAccess = myRole === "owner" || myRole === "admin";

  if (!hasAccess) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <div className="text-center space-y-4 max-w-md">
          <Building2 className="size-12 text-muted-foreground/50 mx-auto" />
          <h2 className="text-2xl font-bold">Access restricted</h2>
          <p className="text-muted-foreground">
            You don't have permission to view organization settings. Contact an
            admin or owner for access.
          </p>
          <Button onClick={() => (window.location.hash = "servers")}>
            Go to Servers
          </Button>
        </div>
      </div>
    );
  }

  return (
    <OrganizationPage
      organization={organization}
      section={section}
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
  checkoutIntent = null,
  onCheckoutIntentConsumed,
  onCheckoutIntentNavigationStarted,
  navigateBillingInSameTab,
  onOrganizationDeleted,
}: OrganizationPageProps) {
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
    entitlements,
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
    error: billingError,
    startPlanChange,
    openPortal,
    openCancellationPortal,
    openIntervalChangePortal,
    cancelScheduledBillingChange,
  } = useOrganizationBilling(organization._id, { enabled: isAuthenticated });
  const billingEntitlementsUiEnabled = useFeatureFlagEnabled(
    "billing-entitlements-ui",
  );
  const billingUiEnabled = billingEntitlementsUiEnabled === true;
  const activeSection: OrganizationRouteSection =
    section === "models"
      ? "models"
      : billingUiEnabled && section === "billing"
        ? "billing"
        : "overview";
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
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const [
    scheduledBillingChangeConfirmOpen,
    setScheduledBillingChangeConfirmOpen,
  ] = useState(false);
  const [pendingPaidUpgradeConfirmation, setPendingPaidUpgradeConfirmation] =
    useState<PendingPaidUpgradeConfirmation | null>(null);
  const [pendingDowngradeConfirmation, setPendingDowngradeConfirmation] =
    useState<PendingDowngradeConfirmation | null>(null);
  const scheduledBillingChangeCancellation =
    getScheduledBillingChangeCancellationState(billingStatus);

  const handleSaveName = async (name: string) => {
    try {
      await updateOrganization({
        organizationId: organization._id,
        name: name.trim(),
      });
    } catch (error) {
      toast.error((error as Error).message || "Failed to update name");
    }
  };

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
    setIsInviting(true);
    try {
      const result = await addMember({
        organizationId: organization._id,
        email: inviteEmail.trim(),
      });
      if (result.isPending) {
        toast.success(
          `Invitation sent to ${inviteEmail}. They'll get access once they sign up.`,
        );
      } else {
        toast.success(`${inviteEmail} added to the organization.`);
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

  const handleRemoveMember = async (email: string) => {
    try {
      await removeMember({
        organizationId: organization._id,
        email,
      });
      toast.success("Member removed");
    } catch (error) {
      toast.error(
        getBillingErrorMessage(
          error,
          "Failed to remove member",
          billingStatus?.canManageBilling ?? false,
        ),
      );
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
        window.location.hash = "servers";
      }
    } catch (error) {
      toast.error((error as Error).message || "Failed to delete organization");
    } finally {
      setIsDeleting(false);
    }
  };

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
      window.location.hash = "servers";
    } catch (error) {
      toast.error((error as Error).message || "Failed to leave organization");
    } finally {
      setIsLeaving(false);
    }
  };

  const initial = organization.name.charAt(0).toUpperCase();
  const auditLogLocked =
    billingUiEnabled && isGateAccessDenied(organizationPremiumness, "auditLog");
  const navigateToSection = (nextSection: OrganizationRouteSection) => {
    window.location.hash = getOrganizationRouteHash(
      organization._id,
      nextSection,
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
      `${window.location.origin}${window.location.pathname}#${getOrganizationRouteHash(
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
    targetBillingInterval: BillingInterval,
  ) => {
    const currentPlan = billingStatus?.plan;

    if (
      currentPlan === "team" &&
      targetPlan === "starter" &&
      billingStatus?.billingInterval != null
    ) {
      setPendingDowngradeConfirmation({
        targetPlan: "starter",
        targetBillingInterval,
        currentPlan,
        currentBillingInterval: billingStatus.billingInterval,
      });
      return;
    }

    if (
      (currentPlan === "starter" || currentPlan === "team") &&
      targetPlan === "free"
    ) {
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
      if (pendingDowngradeConfirmation.targetPlan === "free") {
        const billingUrl = await openCancellationPortal(getBillingReturnUrl());
        openBillingUrl(billingUrl);
        setPendingDowngradeConfirmation(null);
        return;
      }

      const result = await startPlanChange(
        getBillingReturnUrl(),
        "starter",
        pendingDowngradeConfirmation.targetBillingInterval ?? "monthly",
        { confirmPaidPlanChange: false },
      );

      if (result.kind === "updated") {
        toast.success(
          `Plan updated to ${formatPlanName(
            result.subscription.plan ?? pendingDowngradeConfirmation.targetPlan,
          )}.`,
        );
        setPendingDowngradeConfirmation(null);
        return;
      }

      if (result.kind === "scheduled") {
        const targetLabel = formatPlanDescriptor(
          pendingDowngradeConfirmation.targetPlan,
          pendingDowngradeConfirmation.targetBillingInterval,
        );
        toast.success(`Downgrade to ${targetLabel} scheduled for renewal.`);
        setPendingDowngradeConfirmation(null);
        return;
      }

      const billingUrl =
        result.kind === "checkout" ? result.checkoutUrl : result.portalUrl;
      openBillingUrl(billingUrl);
      setPendingDowngradeConfirmation(null);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to change plan",
      );
    }
  };

  const executeManualPlanChange = async (
    tier: "starter" | "team",
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
          `Plan updated to ${formatPlanName(result.subscription.plan ?? tier)}.`,
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
    tier: "starter" | "team",
    billingInterval: "monthly" | "annual",
    options: CheckoutNavigationOptions = {},
  ) => {
    if (shouldConfirmPaidUpgrade(billingStatus, tier)) {
      setPendingPaidUpgradeConfirmation({
        tier,
        billingInterval,
      });
      return;
    }

    await executeManualPlanChange(tier, billingInterval, options);
  };

  const handleConfirmPaidUpgrade = async () => {
    if (!pendingPaidUpgradeConfirmation) return;

    try {
      await executeManualPlanChange(
        pendingPaidUpgradeConfirmation.tier,
        pendingPaidUpgradeConfirmation.billingInterval,
      );
    } finally {
      setPendingPaidUpgradeConfirmation(null);
    }
  };

  const paidUpgradeConfirmationSummary = pendingPaidUpgradeConfirmation
    ? getPaidUpgradeConfirmationSummary(
        planCatalog,
        pendingPaidUpgradeConfirmation.billingInterval,
      )
    : null;
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
    async (tier: "starter" | "team", billingInterval: "monthly" | "annual") => {
      try {
        const result = await startPlanChange(
          getBillingReturnUrl(),
          tier,
          billingInterval,
          { confirmPaidPlanChange: false },
        );

        if (result.kind === "updated") {
          toast.success(
            `Plan updated to ${formatPlanName(result.subscription.plan ?? tier)}.`,
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
        if (
          !(
            error instanceof Error &&
            error.message === PAID_PLAN_CHANGE_CONFIRMATION_REQUIRED_MESSAGE
          )
        ) {
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

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-5">
        <Card className="overflow-hidden border-border/60">
          <CardContent className="space-y-5 p-5">
            <div className="flex flex-col gap-4 md:flex-row md:items-center">
              <div className="relative shrink-0">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleLogoFileChange}
                />
                <Avatar
                  className={`h-24 w-24 ${canEdit ? "cursor-pointer" : ""}`}
                  onClick={handleLogoClick}
                >
                  <AvatarImage
                    src={organization.logoUrl}
                    alt={organization.name}
                  />
                  <AvatarFallback className="bg-muted text-3xl">
                    {initial}
                  </AvatarFallback>
                </Avatar>
                {canEdit ? (
                  <button
                    onClick={handleLogoClick}
                    disabled={isUploadingLogo}
                    className="absolute -bottom-1 -right-1 rounded-full border bg-background p-2"
                    aria-label="Upload organization logo"
                  >
                    {isUploadingLogo ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    ) : (
                      <Camera className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </button>
                ) : null}
              </div>

              <div className="flex-1 space-y-1">
                {canEdit ? (
                  <EditableText
                    value={organization.name}
                    onSave={handleSaveName}
                    className="text-3xl font-semibold -ml-2"
                    placeholder="Organization name"
                  />
                ) : (
                  <h1 className="text-3xl font-semibold">
                    {organization.name}
                  </h1>
                )}
                {billingUiEnabled ? (
                  <p className="text-sm text-muted-foreground">
                    Organization settings
                  </p>
                ) : null}
              </div>
            </div>
          </CardContent>
          <nav
            className="flex items-end gap-1 border-t border-border/60 bg-muted/20 px-2 sm:px-5"
            aria-label="Organization settings sections"
          >
            <button
              type="button"
              onClick={() => navigateToSection("overview")}
              aria-current={activeSection === "overview" ? "page" : undefined}
              className={cn(
                "-mb-px shrink-0 border-b-2 px-3 py-3.5 text-sm font-medium transition-colors sm:px-4",
                activeSection === "overview"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              General
            </button>
            <button
              type="button"
              onClick={() => navigateToSection("models")}
              aria-current={activeSection === "models" ? "page" : undefined}
              className={cn(
                "-mb-px shrink-0 border-b-2 px-3 py-3.5 text-sm font-medium transition-colors sm:px-4",
                activeSection === "models"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              Models
            </button>
            {billingUiEnabled ? (
              <button
                type="button"
                onClick={() => navigateToSection("billing")}
                aria-current={activeSection === "billing" ? "page" : undefined}
                className={cn(
                  "-mb-px shrink-0 border-b-2 px-3 py-3.5 text-sm font-medium transition-colors sm:px-4",
                  activeSection === "billing"
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                Billing
              </button>
            ) : null}
          </nav>
        </Card>

        {activeSection === "models" ? (
          <OrganizationModelsSection
            organizationId={organization._id}
            isAdmin={canEdit}
          />
        ) : activeSection === "billing" ? (
          <>
            <OrganizationBillingSection
              billingStatus={billingStatus}
              organizationName={organization.name}
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
            />
            {billingError ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                {billingError}
              </div>
            ) : null}
          </>
        ) : (
          <>
            <Card className="border-border/60">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-xl">
                  <Users className="size-4 text-muted-foreground" />
                  Members
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                  Active members ({activeMembers.length})
                  {pendingMembers.length > 0
                    ? ` • Pending invites (${pendingMembers.length})`
                    : ""}
                </p>
              </CardHeader>
              <CardContent className="space-y-4 pt-0">
                {canInvite ? (
                  <div className="space-y-3">
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
                          memberInviteGate.isLoading ||
                          memberInviteGate.isDenied
                        }
                      >
                        <UserPlus className="mr-2 size-4" />
                        {isInviting ? "Inviting..." : "Add member"}
                      </Button>
                    </div>

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

                {membersLoading ? (
                  <div className="flex items-center gap-2 py-3 text-muted-foreground">
                    <RefreshCw className="size-4 animate-spin" />
                    Loading members...
                  </div>
                ) : (
                  <div className="space-y-1">
                    {activeMembers.map((member) => {
                      const memberRole = resolveOrganizationRole(member);
                      return (
                        <OrganizationMemberRow
                          key={member._id}
                          member={member}
                          role={memberRole}
                          currentUserEmail={currentUserEmail}
                          canEditRole={isOwner && memberRole !== "owner"}
                          isRoleUpdating={roleUpdatingEmail === member.email}
                          onRoleChange={
                            isOwner && memberRole !== "owner"
                              ? (role) =>
                                  void handleChangeMemberRole(member, role)
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
                              ? () => handleRemoveMember(member.email)
                              : undefined
                          }
                        />
                      );
                    })}
                  </div>
                )}

                {pendingMembers.length > 0 ? (
                  <div className="space-y-1 pt-2">
                    {pendingMembers.map((member) => (
                      <OrganizationMemberRow
                        key={member._id}
                        member={member}
                        currentUserEmail={currentUserEmail}
                        isPending
                        onRemove={
                          canRemovePendingMember()
                            ? () => handleRemoveMember(member.email)
                            : undefined
                        }
                      />
                    ))}
                  </div>
                ) : null}
              </CardContent>
            </Card>

            {billingUiEnabled ? (
              <Card className="border-border/60">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-xl">
                    <CreditCard className="size-4 text-muted-foreground" />
                    Billing
                  </CardTitle>
                  <p className="text-sm text-muted-foreground">
                    Review your plan here or open the billing view for the full
                    pricing matrix, checkout, and subscription management.
                  </p>
                </CardHeader>
                <CardContent className="space-y-3 pt-0">
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
                        onChangeBillingInterval={handleChangeBillingInterval}
                        onCancelScheduledBillingChange={
                          scheduledBillingChangeCancellation
                            ? handleOpenScheduledBillingChangeCancelDialog
                            : undefined
                        }
                        cancelScheduledBillingChangeLabel={
                          scheduledBillingChangeCancellation?.ctaLabel ?? null
                        }
                        onManageBilling={handleManageBilling}
                        isOpeningPortal={isOpeningPortal}
                      />
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <Button
                          size="default"
                          className="h-10 px-5"
                          variant="outline"
                          onClick={handleViewBilling}
                        >
                          View plans
                        </Button>
                        {!billingStatus.canManageBilling ? (
                          <p className="min-w-0 text-sm font-medium text-primary">
                            Only organization owners can manage billing.
                          </p>
                        ) : null}
                      </div>
                    </>
                  ) : null}
                  {billingError ? (
                    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                      {billingError}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            ) : null}

            <Card className="border-border/60">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-xl">
                  <Building2 className="size-4 text-muted-foreground" />
                  Audit Log
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                  Review organization activity and export it as CSV.
                </p>
              </CardHeader>
              <CardContent className="space-y-3 pt-0">
                {billingUiEnabled &&
                (isLoadingEntitlements || isLoadingOrganizationPremiumness) ? (
                  <div className="rounded-md border border-dashed border-border/70 p-3 text-sm text-muted-foreground">
                    Loading audit log access...
                  </div>
                ) : auditLogLocked ? (
                  <div className="rounded-md border border-border/70 p-4">
                    <div className="space-y-1.5">
                      <h3 className="text-sm font-medium">
                        Audit Log requires Enterprise
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        Audit Log is not included on your current plan.
                        {billingStatus?.canManageBilling
                          ? " Upgrade this organization to Enterprise to restore access."
                          : " Ask an organization owner to upgrade to Enterprise."}
                      </p>
                    </div>
                    {billingUiEnabled ? (
                      <Button className="mt-3" onClick={handleViewBilling}>
                        View billing options
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <OrganizationAuditLog
                    organizationId={organization._id}
                    organizationName={organization.name}
                    isAuthenticated={isAuthenticated}
                  />
                )}
              </CardContent>
            </Card>

            <Card className="border-destructive/40">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-xl text-destructive">
                  <AlertTriangle className="size-4" />
                  Danger Zone
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                  These actions are permanent and may remove access for members.
                </p>
              </CardHeader>
              <CardContent className="space-y-2.5 pt-0">
                {!membersLoading && !isOwner ? (
                  <Button
                    variant="outline"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setLeaveConfirmOpen(true)}
                  >
                    <LogOut className="mr-2 size-4" />
                    Leave Organization
                  </Button>
                ) : null}
                {!membersLoading && isOwner ? (
                  <Button
                    variant="outline"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setDeleteConfirmOpen(true)}
                  >
                    <Trash2 className="mr-2 size-4" />
                    Delete Organization
                  </Button>
                ) : null}
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Ownership Transfer Confirmation */}
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
                : "Downgrade to Starter?"}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              {pendingDowngradeConfirmation?.targetPlan === "free" ? (
                <>
                  <span className="block">
                    This cancellation takes effect at renewal, not now.
                  </span>
                  <span className="block">
                    {pendingDowngradeCurrentLabel ?? "Your paid plan"} remains
                    active until{" "}
                    {pendingDowngradeEffectiveDate ??
                      "the end of the current billing period"}
                    .
                  </span>
                  <span className="block">
                    After that, the organization returns to Free.
                  </span>
                </>
              ) : (
                <>
                  <span className="block">
                    This downgrade takes effect at renewal, not now.
                  </span>
                  <span className="block">
                    {pendingDowngradeTargetLabel ?? "Starter"} begins{" "}
                    {pendingDowngradeEffectiveDate ??
                      "at the end of the current billing period"}
                    .
                  </span>
                  <span className="block">
                    {pendingDowngradeCurrentLabel ?? "Your current plan"}{" "}
                    remains active until then.
                  </span>
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-md border border-border/60 bg-muted/30 px-4 py-3 text-sm">
            <span className="font-medium text-foreground">
              {pendingDowngradeConfirmation?.targetPlan === "free"
                ? "Stripe will open a cancellation flow that keeps paid access active until renewal."
                : `${pendingDowngradeTargetLabel ?? "Starter"} will replace ${
                    pendingDowngradeCurrentLabel ?? "the current plan"
                  } at renewal.`}
            </span>
          </div>
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

      <AlertDialog
        open={pendingPaidUpgradeConfirmation !== null}
        onOpenChange={(open) => {
          if (!open && !isStartingPlanChange) {
            setPendingPaidUpgradeConfirmation(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Upgrade to Team?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <span className="block">
                This upgrade takes effect immediately and updates your existing
                Starter subscription in place.
              </span>
              <span className="block">
                We do not send you through Stripe Checkout.
              </span>
              <span className="block">
                Stripe prorates the rest of your current billing period instead
                of waiting until renewal, so unused Starter time is factored
                into the Team change.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-md border border-border/60 bg-muted/30 px-4 py-3 text-sm">
            <span className="font-medium text-foreground">
              {paidUpgradeConfirmationSummary ??
                "Team billing will apply with the 4-seat minimum."}
            </span>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isStartingPlanChange}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleConfirmPaidUpgrade();
              }}
              disabled={isStartingPlanChange}
            >
              {isStartingPlanChange ? "Upgrading..." : "Upgrade now"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Organization?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "{organization.name}" and remove all
              members. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting..." : "Delete Organization"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Leave Confirmation */}
      <AlertDialog open={leaveConfirmOpen} onOpenChange={setLeaveConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave Organization?</AlertDialogTitle>
            <AlertDialogDescription>
              You will lose access to "{organization.name}". You'll need to be
              re-invited to rejoin.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleLeave}
              disabled={isLeaving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isLeaving ? "Leaving..." : "Leave Organization"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
const PAID_PLAN_CHANGE_CONFIRMATION_REQUIRED_MESSAGE =
  "Paid plan changes require an explicit confirmation.";
