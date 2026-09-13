import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@mcpjam/design-system/avatar";
import { Button } from "@mcpjam/design-system/button";
import { Badge } from "@mcpjam/design-system/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { getInitials } from "@/lib/utils";
import { Clock, MoreHorizontal, ArrowRightLeft, Trash2, X } from "lucide-react";
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
  onRoleChange?: (role: "admin" | "member" | "guest") => void;
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
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-3 last:border-b-0 hover:bg-muted/30">
        <div className="size-8 rounded-full bg-muted flex items-center justify-center">
          <Clock className="size-4 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{email}</p>
          <p className="text-xs text-foreground">Waiting for signup</p>
        </div>
        <div className="flex items-center gap-2">
          {onRemove && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
              aria-label={`Cancel invitation for ${email}`}
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
    <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-3 last:border-b-0 hover:bg-muted/30">
      <Avatar className="size-8">
        <AvatarImage src={member.user?.imageUrl || undefined} alt={name} />
        <AvatarFallback className="text-sm">{initials}</AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium truncate">{name}</p>
          {isSelf && <span className="text-xs text-foreground">(you)</span>}
        </div>
        <p className="text-xs text-foreground truncate">{email}</p>
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
              onRoleChange?.(value as "admin" | "member" | "guest")
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
              <SelectItem value="guest">guest</SelectItem>
              <SelectItem value="member">member</SelectItem>
              <SelectItem value="admin">admin</SelectItem>
            </SelectContent>
          </Select>
        )}
        {(canTransferOwnership || canRemove) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={`Actions for ${email}`}
                disabled={isRoleUpdating || isTransferringOwnership}
              >
                <MoreHorizontal aria-hidden="true" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canTransferOwnership && (
                <DropdownMenuItem onSelect={onTransferOwnership}>
                  <ArrowRightLeft aria-hidden="true" className="size-4" />
                  Transfer ownership
                </DropdownMenuItem>
              )}
              {canRemove && (
                <DropdownMenuItem
                  onSelect={onRemove}
                  className="text-destructive"
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                  Remove member
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}
