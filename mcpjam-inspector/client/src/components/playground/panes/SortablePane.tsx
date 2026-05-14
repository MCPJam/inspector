import type { ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface SortablePaneProps {
  id: string;
  title: string;
  icon: LucideIcon;
  onClose?: () => void;
  children: ReactNode;
}

/**
 * A single draggable pane in the Playground IDE shell. Mirrors the dnd-kit
 * pattern from `ServersTab.tsx`'s `SortableServerCard` (the codebase's
 * canonical sortable card) so behavior, animation, and a11y stay consistent.
 *
 * The drag handle is the grip icon in the header. The body is excluded from
 * pointer-drag activation so users can interact normally with form fields,
 * buttons, etc. inside the pane.
 */
export function SortablePane({
  id,
  title,
  icon: Icon,
  onClose,
  children,
}: SortablePaneProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-md border bg-card",
        isDragging && "shadow-lg",
      )}
      data-pane-id={id}
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1.5">
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label={`Drag ${title} pane`}
          className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="flex-1 truncate text-xs font-medium">{title}</span>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title} pane`}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
