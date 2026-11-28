import { useCallback, useEffect, useMemo, useState } from "react";
import { List, ShieldCheck } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { SearchInput } from "@/components/ui/search-input";
import { cn } from "@/lib/utils";
import type { FeatureCardHandlers, ServerRootSummary } from "./ServerCanvasCards";
import { ServerFeatureCanvas } from "./ServerFeatureCanvas";
import { ServerFeatureList } from "./ServerFeatureList";
import {
  FEATURE_FILTERS,
  filterFeatureCards,
  isFeatureFilter,
  type CardModel,
  type FeatureFilter,
} from "./feature-tree";

export type FeatureMapView = "canvas" | "list";

function familyOf(
  cards: readonly CardModel[],
  id: string | null,
): string | null {
  if (!id) return null;
  for (const card of cards) {
    for (const family of card.families) {
      if (family.family.id === id) return id;
      if (family.rows.some((row) => row.feature.id === id))
        return family.family.id;
    }
  }
  return null;
}

/**
 * Which families are open. Search and the state filter open every family
 * that still has rows; the reader can close one, and the next change to the
 * search or filter opens them all again.
 */
function useFamilyExpansion(filterKey: string, filterActive: boolean) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [closed, setClosed] = useState<{ key: string; ids: Set<string> }>({
    key: filterKey,
    ids: new Set(),
  });
  const closedIds = closed.key === filterKey ? closed.ids : new Set<string>();
  const isExpanded = useCallback(
    (id: string) => (filterActive ? !closedIds.has(id) : expanded.has(id)),
    [filterActive, closedIds, expanded],
  );
  const toggle = useCallback(
    (id: string): boolean => {
      const opening = !isExpanded(id);
      if (filterActive) {
        const ids = new Set(closedIds);
        if (opening) ids.delete(id);
        else ids.add(id);
        setClosed({ key: filterKey, ids });
      } else {
        setExpanded((prev) => {
          const next = new Set(prev);
          if (opening) next.add(id);
          else next.delete(id);
          return next;
        });
      }
      return opening;
    },
    [isExpanded, filterActive, closedIds, filterKey],
  );
  const open = useCallback((id: string) => {
    setExpanded((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);
  return { isExpanded, toggle, open };
}

/**
 * The left half of the server page: search, the state filter, the canvas or
 * the list view of the same rows, and the note that opening it runs nothing.
 */
export function ServerFeatureMap({
  root,
  cards,
  selectedId,
  onSelect,
  onOpenRun,
}: {
  root: ServerRootSummary;
  cards: readonly CardModel[];
  /** A feature or family id. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onOpenRun?: (runId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FeatureFilter>("all");
  const [view, setView] = useState<FeatureMapView>("canvas");
  const filtered = useMemo(
    () => filterFeatureCards(cards, { query, filter }),
    [cards, query, filter],
  );
  const expansion = useFamilyExpansion(`${query}\u0000${filter}`, filtered.active);

  // A selection from a deep link or the detail panel opens its family.
  const selectedFamily = familyOf(cards, selectedId);
  const { open } = expansion;
  useEffect(() => {
    if (selectedFamily) open(selectedFamily);
  }, [selectedFamily, open]);

  const handlers = useMemo<FeatureCardHandlers>(
    () => ({
      isExpanded: expansion.isExpanded,
      selectedId,
      onActivateFamily: (familyId) => {
        if (expansion.toggle(familyId)) onSelect(familyId);
      },
      onSelect,
      onOpenRun,
    }),
    [expansion, selectedId, onSelect, onOpenRun],
  );

  return (
    <section
      aria-label="MCP feature map"
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background"
    >
      <div className="flex flex-col gap-3 border-b border-border px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground">
              MCP feature map
            </h2>
            <p className="text-xs text-muted-foreground">
              Every MCP feature, grouped by the specification's sections.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={view === "list"}
            className={cn(view === "list" && "bg-accent text-accent-foreground")}
            onClick={() => setView(view === "list" ? "canvas" : "list")}
          >
            <List aria-hidden className="size-3.5" />
            List view
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search features, ids or methods"
            className="min-w-[200px] flex-1"
          />
          <Select
            value={filter}
            onValueChange={(value) => {
              if (isFeatureFilter(value)) setFilter(value);
            }}
          >
            <SelectTrigger size="sm" aria-label="Show features" className="w-[240px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FEATURE_FILTERS.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {filtered.active ? (
          <p role="status" className="text-xs text-muted-foreground">
            {filtered.matchCount === 1
              ? "1 feature matches."
              : `${filtered.matchCount} features match.`}
          </p>
        ) : null}
      </div>

      <div className={cn("relative min-h-0 flex-1", view === "list" && "p-2")}>
        {filtered.cards.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
            <p>No features match. Clear the search or choose another filter.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setQuery("");
                setFilter("all");
              }}
            >
              Show all features
            </Button>
          </div>
        ) : view === "list" ? (
          <ServerFeatureList cards={filtered.cards} handlers={handlers} />
        ) : (
          <ServerFeatureCanvas
            root={root}
            cards={filtered.cards}
            handlers={handlers}
            onPaneClick={() => onSelect(null)}
          />
        )}
      </div>

      <p className="flex items-center gap-2 border-t border-border px-4 py-2 text-xs text-muted-foreground">
        <ShieldCheck aria-hidden className="size-3.5 shrink-0" />
        Opening this view does not run checks or start server actions.
      </p>
    </section>
  );
}
