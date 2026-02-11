import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getInitials } from "@/lib/utils";
import { Clock, Loader2, X } from "lucide-react";
import {
  type OrganizationMember,
  type OrganizationMembershipRole,
  resolveOrganizationRole,
} from "@/hooks/useOrganizations";

interface OrganizationMemberRowProps {
  member: OrganizationMember;
  currentUserEmail?: string;
  isPending?: boolean;
  role?: OrganizationMembershipRole;
  canEditRole?: boolean;
  isRoleUpdating?: boolean;
  onRoleChange?: (role: "admin" | "member") => void;
  onTransferOwnership?: () => void;
  isTransferringOwnership?: boolean;
  onRemove?: () => void;
}

function roleBadgeVariant(role: OrganizationMembershipRole) {
  if (role === "owner") return "default";
  if (role === "admin") return "secondary";
  return "outline";
}

export function OrganizationMemberRow({
  member,
  currentUserEmail,
  isPending = false,
  role,
  canEditRole = false,
  isRoleUpdating = false,
  onRoleChange,
  onTransferOwnership,
  isTransferringOwnership = false,
  onRemove,
}: OrganizationMemberRowProps) {
  const name = member.user?.name || member.email;
  const email = member.email;
  const initials = getInitials(name);
  const isSelf = email.toLowerCase() === currentUserEmail?.toLowerCase();
  const effectiveRole = resolveOrganizationRole(member, role);
  const canChangeRole =
    canEditRole && effectiveRole !== "owner" && !!onRoleChange;
  const canTransferOwnership =
    effectiveRole !== "owner" && !!onTransferOwnership;
  const showRoleBadge = !canChangeRole;

  const canRemove = !isSelf && effectiveRole !== "owner" && !!onRemove;

  if (isPending) {
    return (
      <div className="flex items-center gap-3 p-2 rounded-md hover:bg-muted/50">
        <div className="size-9 rounded-full bg-muted flex items-center justify-center">
          <Clock className="size-4 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{email}</p>
          <p className="text-xs text-muted-foreground">Waiting for signup</p>
        </div>
        <div className="flex items-center gap-2">
          {onRemove && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
              onClick={onRemove}
            >
              <X className="size-4" />
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 p-2 rounded-md hover:bg-muted/50">
      <Avatar className="size-9">
        <AvatarImage src={member.user?.imageUrl || undefined} alt={name} />
        <AvatarFallback className="text-sm">{initials}</AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium truncate">{name}</p>
          {isSelf && (
            <span className="text-xs text-muted-foreground">(you)</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground truncate">{email}</p>
      </div>

      <div className="flex items-center gap-2">
        {showRoleBadge && (
          <Badge variant={roleBadgeVariant(effectiveRole)}>
            {effectiveRole}
          </Badge>
        )}
        {canChangeRole && (
          <Select
            value={effectiveRole}
            onValueChange={(value) =>
              onRoleChange?.(value as "admin" | "member")
            }
            disabled={isRoleUpdating}
          >
            <SelectTrigger
              size="sm"
              className="min-w-[120px]"
              aria-label={`Role for ${email}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="member">member</SelectItem>
              <SelectItem value="admin">admin</SelectItem>
            </SelectContent>
          </Select>
        )}
        {canTransferOwnership && (
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            disabled={isTransferringOwnership}
            onClick={onTransferOwnership}
          >
            {isTransferringOwnership ? (
              <Loader2 className="mr-2 size-3.5 animate-spin" />
            ) : null}
            Transfer ownership
          </Button>
        )}
        {canRemove && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
            disabled={isRoleUpdating || isTransferringOwnership}
            onClick={onRemove}
          >
            <X className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
