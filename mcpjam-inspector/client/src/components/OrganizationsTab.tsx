import { useState, useRef } from "react";
import { useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EditableText } from "@/components/ui/editable-text";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Organization,
  OrganizationMember,
  type OrganizationMembershipRole,
  resolveOrganizationRole,
  useOrganizationQueries,
  useOrganizationMembers,
  useOrganizationMutations,
} from "@/hooks/useOrganizations";
import { useOrganizationBilling } from "@/hooks/useOrganizationBilling";
import { OrganizationMemberRow } from "./organization/OrganizationMemberRow";

interface OrganizationsTabProps {
  organizationId?: string;
}

export function OrganizationsTab({ organizationId }: OrganizationsTabProps) {
  const { user, signIn } = useAuth();
  const { isAuthenticated } = useConvexAuth();

  const { sortedOrganizations, isLoading } = useOrganizationQueries({
    isAuthenticated,
  });

  // Find the organization by ID
  const organization = organizationId
    ? sortedOrganizations.find((org) => org._id === organizationId)
    : null;

  if (!user) {
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

  return <OrganizationPage organization={organization} />;
}

interface OrganizationPageProps {
  organization: Organization;
}

function OrganizationPage({ organization }: OrganizationPageProps) {
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
    isLoadingBilling,
    isStartingCheckout,
    isOpeningPortal,
    error: billingError,
    startCheckout,
    openPortal,
  } = useOrganizationBilling(organization._id);

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
      toast.error((error as Error).message || "Failed to invite member");
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
      toast.error((error as Error).message || "Failed to remove member");
    }
  };

  const handleChangeMemberRole = async (
    member: OrganizationMember,
    role: "admin" | "member",
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
      window.location.hash = "servers";
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

  const handleBillingAction = async () => {
    if (!billingStatus) return;

    try {
      const returnUrl = `${window.location.origin}${window.location.pathname}#organizations/${organization._id}`;
      const billingUrl =
        billingStatus.plan === "pro"
          ? await openPortal(returnUrl)
          : await startCheckout(returnUrl);
      window.open(billingUrl, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to start billing flow",
      );
    }
  };

  const initial = organization.name.charAt(0).toUpperCase();
  const isBillingActionPending = isStartingCheckout || isOpeningPortal;
  const billingActionLabel =
    billingStatus?.plan === "pro"
      ? "Manage subscription"
      : "Upgrade to MCPJam Pro";
  const formattedPeriodEnd =
    billingStatus?.stripeCurrentPeriodEnd != null
      ? new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        }).format(new Date(billingStatus.stripeCurrentPeriodEnd))
      : "Not available";
  const subscriptionStatusLabel = billingStatus?.subscriptionStatus
    ? billingStatus.subscriptionStatus.replace(/_/g, " ")
    : "Not subscribed";
  const billingAccountLabel = billingStatus?.hasCustomer
    ? "Connected"
    : "Not connected";

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-5 p-4 md:p-5">
        <Card className="border-border/60">
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

              <div className="flex-1">
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
              </div>
            </div>

            <div className="h-px bg-border/70" />

            <div className="space-y-4">
              <div className="space-y-1">
                <h2 className="flex items-center gap-2 text-xl font-semibold">
                  <Users className="size-4 text-muted-foreground" />
                  Members
                </h2>
                <p className="text-sm text-muted-foreground">
                  Active members ({activeMembers.length})
                  {pendingMembers.length > 0
                    ? ` • Pending invites (${pendingMembers.length})`
                    : ""}
                </p>
              </div>

              {canInvite ? (
                <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
                  <Input
                    placeholder="Email address"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleInvite()}
                    className="h-9 w-full sm:w-80"
                  />
                  <Button
                    size="sm"
                    className="h-9"
                    onClick={handleInvite}
                    disabled={!inviteEmail.trim() || isInviting}
                  >
                    <UserPlus className="mr-2 size-4" />
                    {isInviting ? "Inviting..." : "Add member"}
                  </Button>
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
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/60">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-xl">
              <CreditCard className="size-4 text-muted-foreground" />
              Billing
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              View your plan details and manage your subscription settings.
            </p>
          </CardHeader>
          <CardContent className="space-y-3 pt-0">
            {isLoadingBilling ? (
              <div className="rounded-md border border-dashed border-border/70 p-3 text-sm text-muted-foreground">
                Loading billing details...
              </div>
            ) : billingStatus ? (
              <>
                <div className="grid gap-3 rounded-md border border-border/70 p-3.5 sm:grid-cols-2">
                  <div className="space-y-1">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Current plan
                    </p>
                    <Badge
                      variant={
                        billingStatus.plan === "pro" ? "default" : "secondary"
                      }
                    >
                      {billingStatus.plan.toUpperCase()}
                    </Badge>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Subscription status
                    </p>
                    <p className="text-sm font-medium capitalize">
                      {subscriptionStatusLabel}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Current period ends
                    </p>
                    <p className="text-sm font-medium">{formattedPeriodEnd}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Billing account
                    </p>
                    <p className="text-sm font-medium">{billingAccountLabel}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Button
                    size="default"
                    className="h-10 px-5"
                    variant={
                      billingStatus.plan === "pro" ? "outline" : "default"
                    }
                    onClick={handleBillingAction}
                    disabled={
                      !billingStatus.canManageBilling || isBillingActionPending
                    }
                  >
                    {isBillingActionPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading...
                      </>
                    ) : (
                      billingActionLabel
                    )}
                  </Button>
                </div>
                {!billingStatus.canManageBilling ? (
                  <p className="text-xs text-muted-foreground">
                    Only organization owners can manage billing.
                  </p>
                ) : null}
              </>
            ) : null}
            {billingError ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                {billingError}
              </div>
            ) : null}
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
