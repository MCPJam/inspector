import { MoreVertical, Pencil, Copy, Trash2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { CardInteractive } from "@mcpjam/design-system/card";
import { Button } from "@mcpjam/design-system/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import type { HostListItem } from "@/hooks/useClients";

interface HostCardProps {
  host: HostListItem;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  isDuplicating?: boolean;
  isDeleting?: boolean;
}

export function ClientCard({
  host,
  onEdit,
  onDuplicate,
  onDelete,
  isDuplicating = false,
  isDeleting = false,
}: HostCardProps) {
  const serverLabel =
    host.serverCount === 1
      ? "1 server"
      : `${host.serverCount} servers`;

  return (
    <CardInteractive className="flex flex-col gap-4" onClick={onEdit}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 flex-1 truncate text-lg font-bold tracking-tight">
          {host.name}
        </h3>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEdit(); }}>
              <Pencil className="mr-2 h-4 w-4" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={(e) => { e.stopPropagation(); onDuplicate(); }}
              disabled={isDuplicating}
            >
              <Copy className="mr-2 h-4 w-4" />
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              disabled={isDeleting}
              className="text-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <p className="truncate text-sm text-muted-foreground">
        {host.modelId} · {serverLabel}
      </p>

      <p className="text-xs text-muted-foreground">
        Updated {formatDistanceToNow(host.updatedAt, { addSuffix: true })}
      </p>
    </CardInteractive>
  );
}
