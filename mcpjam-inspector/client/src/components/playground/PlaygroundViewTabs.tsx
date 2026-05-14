import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Plus,
  Star,
  Trash2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { cn } from "@/lib/utils";
import type {
  PlaygroundViewId,
  PlaygroundViewSummary,
} from "@/hooks/use-playground-views";

interface PlaygroundViewTabsProps {
  views: PlaygroundViewSummary[];
  activeViewId: PlaygroundViewId | null;
  isDirty: boolean;
  isLoading: boolean;
  onSelect: (viewId: PlaygroundViewId | null) => void;
  onSaveAs: () => void;
  onRename: (view: PlaygroundViewSummary) => void;
  onSetDefault: (viewId: PlaygroundViewId) => void;
  onDelete: (view: PlaygroundViewSummary) => void;
}

/**
 * Horizontal tab strip for Playground views — same visual pattern as
 * `ActiveServerSelector`, but purpose-built so we don't have to fake server
 * fields like `connectionStatus` / `lastConnectionTime`. Tabs scroll
 * horizontally with chevron buttons when overflow occurs.
 *
 * Layout: [scratch?] [view-1] [view-2] … [+ new]
 *   - "scratch" tab only renders when `activeViewId === null`. The implicit
 *     scratch workspace isn't persisted, so showing it as a permanent tab
 *     would be misleading.
 *   - The active tab carries the dirty dot; inactive tabs have a static
 *     transparent dot so widths stay stable when toggling.
 *   - Per-tab "⋯" reveals on hover/focus and only shows for saved views.
 *   - Trailing "+" opens Save As (creates a new view from current state).
 */
export function PlaygroundViewTabs({
  views,
  activeViewId,
  isDirty,
  isLoading,
  onSelect,
  onSaveAs,
  onRename,
  onSetDefault,
  onDelete,
}: PlaygroundViewTabsProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    const update = () => {
      setCanScrollLeft(node.scrollLeft > 0);
      setCanScrollRight(
        node.scrollLeft + node.clientWidth < node.scrollWidth - 1,
      );
    };
    update();
    node.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      node.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [views.length, activeViewId]);

  const scroll = (direction: "left" | "right") => {
    const node = scrollRef.current;
    if (!node) return;
    const amount = 200;
    const next =
      direction === "left"
        ? Math.max(0, node.scrollLeft - amount)
        : Math.min(
            node.scrollWidth - node.clientWidth,
            node.scrollLeft + amount,
          );
    node.scrollTo({ left: next, behavior: "smooth" });
  };

  const isScratchActive = activeViewId === null;

  return (
    <div className="relative h-full min-w-0 flex-1">
      <div
        ref={scrollRef}
        className="scrollbar-hidden flex h-full min-w-0 overflow-x-auto"
      >
        <div className="flex h-full min-w-fit flex-nowrap items-stretch">
          {isLoading && views.length === 0 ? (
            <div className="flex h-full items-center gap-2 px-3 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading views…
            </div>
          ) : null}

          {isScratchActive ? (
            <ViewTab
              label="Untitled (scratch)"
              isActive
              isDirty={isDirty}
              isDefault={false}
              onClick={() => onSelect(null)}
            />
          ) : null}

          {views.map((view) => {
            const isActive = view._id === activeViewId;
            return (
              <ViewTab
                key={view._id}
                label={view.name}
                isActive={isActive}
                isDirty={isActive && isDirty}
                isDefault={view.isDefault}
                onClick={() => onSelect(view._id)}
                menu={
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        onClick={(e) => e.stopPropagation()}
                        className={cn(
                          "ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground/70 transition-opacity",
                          "opacity-0 hover:bg-muted-foreground/15 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
                        )}
                        aria-label={`Actions for ${view.name}`}
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <DropdownMenuItem onSelect={() => onRename(view)}>
                        Rename…
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => onSetDefault(view._id)}
                        disabled={view.isDefault}
                      >
                        {view.isDefault ? "Default view" : "Set as default"}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() => onDelete(view)}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="mr-2 h-3.5 w-3.5" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                }
              />
            );
          })}

          <button
            type="button"
            onClick={onSaveAs}
            className={cn(
              "group flex h-full items-center gap-1.5 border-r border-dashed border-border px-3 text-xs",
              "text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
            )}
            aria-label="Save current state as new view"
            title="Save as new view"
          >
            <Plus className="h-3.5 w-3.5" />
            New view
          </button>
        </div>
      </div>

      {canScrollLeft ? (
        <button
          type="button"
          className="absolute left-0 top-0 flex h-full items-center bg-gradient-to-r from-background via-background/95 to-background/0 px-2"
          onClick={() => scroll("left")}
          aria-label="Scroll view tabs left"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      ) : null}
      {canScrollRight ? (
        <button
          type="button"
          className="absolute right-0 top-0 flex h-full items-center bg-gradient-to-l from-background via-background/95 to-background/0 px-2"
          onClick={() => scroll("right")}
          aria-label="Scroll view tabs right"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}

function ViewTab({
  label,
  isActive,
  isDirty,
  isDefault,
  onClick,
  menu,
}: {
  label: string;
  isActive: boolean;
  isDirty: boolean;
  isDefault: boolean;
  onClick: () => void;
  menu?: React.ReactNode;
}) {
  return (
    <div
      role="tab"
      aria-selected={isActive}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "group relative flex h-full cursor-pointer items-center gap-1.5 border-r border-border px-3 text-xs font-medium outline-none transition-colors",
        "hover:bg-accent/60 focus-visible:bg-accent",
        isActive
          ? "bg-muted text-foreground"
          : "bg-background text-muted-foreground hover:text-foreground",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full transition-colors",
          isDirty ? "bg-amber-500" : "bg-transparent",
        )}
        aria-label={isDirty ? "Unsaved changes" : undefined}
      />
      <span className="max-w-[160px] truncate">{label}</span>
      {isDefault ? (
        <Star className="h-3 w-3 shrink-0 fill-current text-amber-500" />
      ) : null}
      {menu}
    </div>
  );
}
