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
  Loader2,
  LogOut,
  RefreshCw,
  Trash2,
  UserPlus,
} from "lucide-react";
import { toast } from "sonner";
import {
  Organization,
  useOrganizationQueries,
  useOrganizationMembers,
  useOrganizationMutations,
} from "@/hooks/useOrganizations";
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
    removeMember,
    generateLogoUploadUrl,
    updateOrganizationLogo,
  } = useOrganizationMutations();

  // All members can edit the organization
  const canEdit = true;

  // Determine if current user is the creator (for delete vs leave)
  const currentMember = activeMembers.find(
    (m) => m.email.toLowerCase() === currentUserEmail?.toLowerCase(),
  );
  const isCreator = currentMember?.userId === organization.createdBy;

  // Logo upload state
  const [isUploadingLogo, setIsUploadingLogo] = useState(false);

  // Invite state
  const [inviteEmail, setInviteEmail] = useState("");
  const [isInviting, setIsInviting] = useState(false);

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
    if (!inviteEmail.trim()) return;
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

  const initial = organization.name.charAt(0).toUpperCase();

  return (
    <div className="p-8 max-w-4xl overflow-auto h-full">
      {/* Organization Header - Similar to Profile */}
      <div className="flex items-start gap-6 mb-12">
        {/* Organization Avatar with Upload */}
        <div className="relative group shrink-0">
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
            <AvatarImage src={organization.logoUrl} alt={organization.name} />
            <AvatarFallback className="bg-primary/10 text-primary text-4xl">
              {initial}
            </AvatarFallback>
          </Avatar>
          {/* Camera Icon Overlay - only show for users who can edit */}
          {canEdit && (
            <button
              onClick={handleLogoClick}
              disabled={isUploadingLogo}
              className="absolute bottom-0 left-0 p-1.5 bg-background border border-border rounded-full shadow-sm hover:bg-accent transition-colors cursor-pointer"
            >
              {isUploadingLogo ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              ) : (
                <Camera className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </button>
          )}
        </div>

        {/* Organization Info */}
        <div className="flex-1 pt-2">
          {/* Editable Name */}
          {canEdit ? (
            <EditableText
              value={organization.name}
              onSave={handleSaveName}
              className="text-3xl font-semibold -ml-2"
              placeholder="Organization name"
            />
          ) : (
            <h1 className="text-3xl font-semibold">{organization.name}</h1>
          )}
        </div>
      </div>

      {/* Members Section */}
      <div className="mb-12">
        <h2 className="text-xl font-semibold mb-6">Members</h2>

        {/* Invite Member */}
        {canEdit && (
          <div className="mb-6">
            <label className="text-sm font-medium text-muted-foreground block mb-2">
              Invite New Member
            </label>
            <div className="flex gap-2">
              <Input
                placeholder="Email address"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleInvite()}
                className="max-w-sm"
              />
              <Button
                onClick={handleInvite}
                disabled={!inviteEmail.trim() || isInviting}
              >
                <UserPlus className="size-4 mr-2" />
                {isInviting ? "Inviting..." : "Invite"}
              </Button>
            </div>
          </div>
        )}

        {/* Active Members */}
        <div className="mb-6">
          <label className="text-sm font-medium text-muted-foreground block mb-2">
            Active Members ({activeMembers.length})
          </label>
          {membersLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground py-4">
              <RefreshCw className="size-4 animate-spin" />
              Loading members...
            </div>
          ) : (
            <div className="space-y-1 border rounded-lg p-2">
              {activeMembers.map((member) => (
                <OrganizationMemberRow
                  key={member._id}
                  member={member}
                  currentUserEmail={currentUserEmail}
                  onRemove={
                    // Can't remove the owner (creator)
                    !member.isOwner
                      ? () => handleRemoveMember(member.email)
                      : undefined
                  }
                />
              ))}
            </div>
          )}
        </div>

        {/* Pending Invitations */}
        {pendingMembers.length > 0 && (
          <div>
            <label className="text-sm font-medium text-muted-foreground block mb-2">
              Pending Invitations ({pendingMembers.length})
            </label>
            <div className="space-y-1 border rounded-lg p-2 border-dashed">
              {pendingMembers.map((member) => (
                <OrganizationMemberRow
                  key={member._id}
                  member={member}
                  currentUserEmail={currentUserEmail}
                  isPending
                  onRemove={() => handleRemoveMember(member.email)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Danger Zone */}
      <div>
        <h2 className="text-xl font-semibold mb-2 text-destructive flex items-center gap-2">
          <AlertTriangle className="size-5" />
          Danger Zone
        </h2>
        <p className="text-sm text-muted-foreground mb-4">
          Irreversible and destructive actions
        </p>

        <div className="border border-destructive/50 rounded-lg p-6 space-y-6">
          {!isCreator && (
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium">Leave Organization</h3>
                <p className="text-sm text-muted-foreground">
                  Remove yourself from this organization. You will lose access
                  to all organization resources.
                </p>
              </div>
              <Button
                variant="outline"
                className="text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0 ml-4"
                onClick={() => setLeaveConfirmOpen(true)}
              >
                <LogOut className="size-4 mr-2" />
                Leave
              </Button>
            </div>
          )}

          {isCreator && (
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium">Delete Organization</h3>
                <p className="text-sm text-muted-foreground">
                  Permanently delete this organization and all associated data.
                </p>
              </div>
              <Button
                variant="outline"
                className="text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0 ml-4"
                onClick={() => setDeleteConfirmOpen(true)}
              >
                <Trash2 className="size-4 mr-2" />
                Delete
              </Button>
            </div>
          )}
        </div>
      </div>

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
