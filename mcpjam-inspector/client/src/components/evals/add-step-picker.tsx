import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import type { LucideIcon } from "lucide-react";
import {
  ChevronRight,
  Eye,
  EyeOff,
  FormInput,
  LayoutPanelTop,
  MessageSquare,
  MessageSquareText,
  MousePointerClick,
  Plus,
  Shield,
  Type,
  Wrench,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { cn } from "@/lib/utils";
import {
  PICKER_CATALOG,
  PICKER_GROUP_DESCRIPTIONS,
  PICKER_GROUP_LABELS,
  PICKER_GROUP_ORDER,
  secondaryCount,
  type AddStepPickerChoice,
  type PickerCatalogEntry,
  type PickerGroupId,
} from "./add-step-picker-catalog";

export type { AddStepPickerChoice };

type PickerItem = PickerCatalogEntry & { Icon: LucideIcon };

const PICKER_ITEM_ICONS: Record<string, LucideIcon> = {
  prompt: MessageSquare,
  interact: MousePointerClick,
  toolCall: Wrench,
  "check:toolCalledWith": Wrench,
  "check:responseContains": MessageSquareText,
  "check:widgetRendered": LayoutPanelTop,
  "check:toolCalledAtLeastOnce": Wrench,
  "check:toolNeverCalled": Wrench,
  "check:firstToolWas": Wrench,
  "check:responseMatches": MessageSquareText,
  "check:finalAssistantMessageNonEmpty": MessageSquareText,
  "check:widgetRenderLatencyUnder": LayoutPanelTop,
  "check:widgetNoConsoleErrors": Shield,
  "check:noToolErrors": Shield,
  "widget:textVisible": Type,
  "widget:elementVisible": Eye,
  "widget:elementHidden": EyeOff,
  "widget:inputValue": FormInput,
};

const PICKER_ITEMS: PickerItem[] = PICKER_CATALOG.map((entry) => ({
  ...entry,
  Icon: PICKER_ITEM_ICONS[entry.key] ?? Wrench,
}));

function itemMatchesQuery(item: PickerItem, query: string): boolean {
  if (!query) return true;
  const haystack = [
    item.label,
    item.hint ?? "",
    PICKER_GROUP_LABELS[item.group],
    PICKER_GROUP_DESCRIPTIONS[item.group],
    ...item.keywords,
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

export type AddStepPickerProps = {
  onSelect: (choice: AddStepPickerChoice) => void;
  className?: string;
  /**
   * Reveal tier-2 checks (more conversation, widget, health) by default instead
   * of hiding them behind the expander. The step list sets this once the case
   * has interaction steps.
   */
  defaultMoreExpanded?: boolean;
};

export function AddStepPicker({
  onSelect,
  className,
  defaultMoreExpanded = false,
}: AddStepPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [moreExpanded, setMoreExpanded] = useState(defaultMoreExpanded);
  const [activeKey, setActiveKey] = useState(PICKER_ITEMS[0]!.key);
  const searchRef = useRef<HTMLInputElement>(null);

  const query = search.trim().toLowerCase();
  const isSearching = query.length > 0;

  const filteredItems = useMemo(
    () => PICKER_ITEMS.filter((item) => itemMatchesQuery(item, query)),
    [query],
  );

  const visibleItems = useMemo(() => {
    if (isSearching || moreExpanded) return filteredItems;
    return filteredItems.filter((item) => item.tier === "primary");
  }, [filteredItems, isSearching, moreExpanded]);

  const groupedItems = useMemo(() => {
    const byGroup = new Map<PickerGroupId, PickerItem[]>();
    for (const group of PICKER_GROUP_ORDER) {
      byGroup.set(group, []);
    }
    for (const item of visibleItems) {
      byGroup.get(item.group)!.push(item);
    }
    return PICKER_GROUP_ORDER.map((group) => ({
      group,
      items: byGroup.get(group) ?? [],
    })).filter((entry) => entry.items.length > 0);
  }, [visibleItems]);

  const flatVisible = useMemo(
    () => groupedItems.flatMap((entry) => entry.items),
    [groupedItems],
  );

  const hiddenSecondaryCount = useMemo(() => {
    if (isSearching || moreExpanded) return 0;
    return filteredItems.filter((item) => item.tier === "secondary").length;
  }, [filteredItems, isSearching, moreExpanded]);

  useEffect(() => {
    if (!open) {
      setSearch("");
      setMoreExpanded(defaultMoreExpanded);
      setActiveKey(PICKER_ITEMS[0]!.key);
      return;
    }
    const id = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open, defaultMoreExpanded]);

  useEffect(() => {
    if (flatVisible.length === 0) return;
    const hasActive = flatVisible.some((item) => item.key === activeKey);
    if (!hasActive) {
      setActiveKey(flatVisible[0]!.key);
    }
  }, [activeKey, flatVisible]);

  const pick = (item: PickerItem) => {
    onSelect(item.choice);
    setOpen(false);
  };

  const moveActive = (delta: number) => {
    if (flatVisible.length === 0) return;
    const index = flatVisible.findIndex((item) => item.key === activeKey);
    const next =
      index < 0
        ? flatVisible[0]!
        : flatVisible[
            (index + delta + flatVisible.length) % flatVisible.length
          ]!;
    setActiveKey(next.key);
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const active = flatVisible.find((item) => item.key === activeKey);
      if (active) pick(active);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label="Add step"
          className={cn("h-8 gap-1.5 border-dashed text-xs", className)}
        >
          <Plus className="h-3.5 w-3.5" />
          Add…
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-64 p-1"
      >
        <div className="px-1 pb-1">
          <Input
            ref={searchRef}
            value={search}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              setSearch(event.target.value)
            }
            onKeyDown={handleSearchKeyDown}
            placeholder="Filter…"
            aria-label="Filter steps and checks"
            className="h-7 border-none bg-transparent px-2 text-xs shadow-none focus-visible:ring-0"
          />
        </div>

        {groupedItems.length > 0 ? (
          <div className="max-h-80 space-y-1 overflow-y-auto">
            {groupedItems.map(({ group, items }) => (
              <section key={group}>
                <div className="px-2 pt-1.5 pb-0.5">
                  <div className="text-[11px] font-medium text-foreground">
                    {PICKER_GROUP_LABELS[group]}
                  </div>
                  <div className="text-[10px] leading-tight text-muted-foreground">
                    {PICKER_GROUP_DESCRIPTIONS[group]}
                  </div>
                </div>
                {items.map((item) => {
                  const isActive = activeKey === item.key;
                  const { Icon } = item;

                  return (
                    <button
                      key={item.key}
                      type="button"
                      data-testid={`add-step-item-${item.key}`}
                      onMouseEnter={() => setActiveKey(item.key)}
                      onClick={() => pick(item)}
                      className={cn(
                        "flex w-full flex-col rounded-sm px-2 py-1.5 text-left text-xs",
                        isActive
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-accent/50",
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <Icon
                          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                        {item.label}
                      </span>
                      {item.hint ? (
                        <span className="pl-[1.375rem] text-[10px] leading-tight text-muted-foreground">
                          {item.hint}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </section>
            ))}

            {hiddenSecondaryCount > 0 ? (
              <button
                type="button"
                data-testid="add-step-expand-more"
                onClick={() => setMoreExpanded(true)}
                className="flex w-full items-center gap-1 rounded-sm px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              >
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                More checks ({hiddenSecondaryCount})
              </button>
            ) : null}
          </div>
        ) : (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            No matches
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

// Re-export for tests that assert the default secondary count.
export { secondaryCount };
