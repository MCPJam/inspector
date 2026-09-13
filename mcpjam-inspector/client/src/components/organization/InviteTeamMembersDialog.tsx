import { useState } from "react";
import {
  useOrganizationMutations,
  useOrganizationQueries,
} from "@/hooks/useOrganizations";
import { useAppNavigate, buildOrganizationPath } from "@/lib/app-navigation";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@mcpjam/design-system/dialog";
import { toast } from "@/lib/toast";

export function InviteTeamMembersDialog({
  organizationId,
  organizationName,
  onClose,
}: {
  organizationId: string;
  organizationName?: string;
  onClose: () => void;
}) {
  const { sortedOrganizations } = useOrganizationQueries({
    isAuthenticated: true,
  });
  const organization = sortedOrganizations.find(
    (org) => org._id === organizationId,
  );
  const canInvite =
    !organization?.seatPending &&
    (organization?.myRole === "owner" || organization?.myRole === "admin");
  const { addMember } = useOrganizationMutations();
  const navigate = useAppNavigate();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canInvite || busy || !email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await addMember({
        organizationId,
        email: email.trim(),
        role: "member",
      });
      if (result.needsSeatPayment) {
        toast.info(
          "Complete the seat payment in Members & sharing to finish adding this member.",
        );
        onClose();
        navigate(buildOrganizationPath(organizationId, "members"));
        return;
      }
      toast.success(
        result.isPending
          ? `Invitation sent to ${email.trim()}.`
          : `${email.trim()} added to the organization.`,
      );
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not send invitation. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite team members</DialogTitle>
          <DialogDescription>
            Invite someone to{" "}
            {organization?.name ?? organizationName ?? "your organization"}.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="team-invite-email">Email address</Label>
            <Input
              id="team-invite-email"
              type="email"
              autoFocus
              required
              placeholder="name@company.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={!canInvite || busy}
            />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">Organization role: Member</p>
            <p className="text-sm text-muted-foreground">
              Members can access organization-visible projects. Private projects
              require a separate invitation.
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            On a paid plan, adding a member may require a paid seat. Any
            required payment is completed in Members & sharing.
          </p>
          {organization && !canInvite && (
            <p role="status" className="text-sm text-muted-foreground">
              Ask an organization owner or admin to invite team members.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!canInvite || busy || !email.trim()}
            >
              {busy ? "Sending…" : "Send invite"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
