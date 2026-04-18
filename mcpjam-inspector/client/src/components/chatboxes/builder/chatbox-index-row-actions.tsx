import {
  BarChart3,
  Copy,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import type { ChatboxListItem } from "@/hooks/useChatboxes";

/** Row/card overflow menu. Copy hosted link / open hosted need link token on list items — future list API. */
export function ChatboxIndexRowActionsMenu({
  chatbox,
  onEdit,
  onUsage,
  onDuplicate,
  onDelete,
  isDeleting,
  isDuplicating,
  triggerClassName = "text-muted-foreground shrink-0 -mr-1 -mt-1",
}: {
  chatbox: ChatboxListItem;
  onEdit: () => void;
  onUsage: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  isDeleting: boolean;
  isDuplicating: boolean;
  /** Trigger button classes (card vs list row alignment). */
  triggerClassName?: string;
}) {
  const busy = isDeleting || isDuplicating;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={triggerClassName}
          aria-label={`Chatbox actions for ${chatbox.name}`}
          aria-haspopup="menu"
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <MoreHorizontal className="size-4" aria-hidden />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-48"
        onClick={(event) => event.stopPropagation()}
      >
        <DropdownMenuItem
          disabled={busy}
          onSelect={() => {
            onEdit();
          }}
        >
          <Pencil className="size-4" />
          Edit in builder
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={busy}
          onSelect={() => {
            onUsage();
          }}
        >
          <BarChart3 className="size-4" />
          Usage &amp; insights
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={busy}
          onSelect={() => {
            onDuplicate();
          }}
        >
          <Copy className="size-4" />
          Duplicate
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={busy}
          onSelect={() => {
            onDelete();
          }}
        >
          <Trash2 className="size-4" />
          Delete chatbox
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
