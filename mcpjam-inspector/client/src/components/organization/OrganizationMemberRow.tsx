import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { getInitials } from "@/lib/utils";
import { Clock, X } from "lucide-react";
import { OrganizationMember } from "@/hooks/useOrganizations";

interface OrganizationMemberRowProps {
  member: OrganizationMember;
  currentUserEmail?: string;
  isPending?: boolean;
  onRemove?: () => void;
}

export function OrganizationMemberRow({
  member,
  currentUserEmail,
  isPending = false,
  onRemove,
}: OrganizationMemberRowProps) {
  const name = member.user?.name || member.email;
  const email = member.email;
  const initials = getInitials(name);
  const isSelf = email.toLowerCase() === currentUserEmail?.toLowerCase();

  // Can remove if not self, not owner, and onRemove is provided
  const canRemove = !isSelf && !member.isOwner && !!onRemove;

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
        {canRemove && (
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
