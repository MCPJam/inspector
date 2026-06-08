import { useCallback, useEffect, useRef, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ProductUpdateHoverCard } from "./ProductUpdateHoverCard";
import { ProductUpdateExpandedPanel } from "./ProductUpdateExpandedPanel";
import type { ProductUpdateEntry } from "./productUpdateEntry";

const PREVIEW_LIMIT = 3;

function formatPublishDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function UpdateRow({
  update,
  isLast,
  onSelect,
  onDismiss,
}: {
  update: ProductUpdateEntry;
  isLast: boolean;
  onSelect: (entry: ProductUpdateEntry, sourceRect: DOMRect | null) => void;
  onDismiss: (slug: string) => void;
}) {
  return (
    <li className={isLast ? "" : "border-b border-border/40"}>
      <div className="group flex items-center">
        <div className="min-w-0 flex-1">
          <ProductUpdateHoverCard entry={update} onExpand={onSelect}>
            <button
              type="button"
              onClick={(e) =>
                onSelect(update, e.currentTarget.getBoundingClientRect())
              }
              className="flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-accent/40"
            >
            <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
              {update.title}
            </p>
            <div className="flex shrink-0 items-center gap-1.5">
              {update.isNew ? (
                <span className="text-[10px] font-medium uppercase tracking-wide text-primary">
                  New
                </span>
              ) : null}
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {formatPublishDate(update.publishAt)}
              </span>
              <ChevronRight className="size-3 text-muted-foreground/40 transition group-hover:text-muted-foreground" />
            </div>
            </button>
          </ProductUpdateHoverCard>
        </div>
        <button
          type="button"
          onClick={() => onDismiss(update.slug)}
          aria-label={`Dismiss ${update.title}`}
          className="mr-2 shrink-0 rounded p-1 text-muted-foreground/50 opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
        >
          <X className="size-3" />
        </button>
      </div>
    </li>
  );
}

export function ProductUpdatesRow() {
  const { isAuthenticated } = useConvexAuth();
  const updates = useQuery(
    "productUpdates:listVisibleUpdates" as any,
    isAuthenticated ? ({} as any) : "skip",
  ) as ProductUpdateEntry[] | undefined;

  const initialize = useMutation(
    "productUpdates:initializeIfNeeded" as any,
  );
  const dismissUpdate = useMutation("productUpdates:dismissUpdate" as any);

  const [expanded, setExpanded] = useState<{
    entry: ProductUpdateEntry;
    sourceRect: DOMRect | null;
  } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [clearing, setClearing] = useState(false);
  const initRef = useRef(false);

  useEffect(() => {
    if (!isAuthenticated || initRef.current) return;
    initRef.current = true;
    initialize({}).catch((err) => {
      initRef.current = false;
      console.error("Failed to initialize product updates:", err);
    });
  }, [isAuthenticated, initialize]);

  const handleDismiss = useCallback(
    async (slug: string) => {
      try {
        await dismissUpdate({ slug });
        setExpanded((current) =>
          current?.entry.slug === slug ? null : current,
        );
      } catch (err) {
        console.error("Failed to dismiss product update:", err);
      }
    },
    [dismissUpdate],
  );

  const handleClearAll = useCallback(async () => {
    if (!updates) return;
    const pending = updates.filter((update) => !update.dismissed);
    if (pending.length === 0) return;

    setClearing(true);
    try {
      await Promise.all(
        pending.map((update) => dismissUpdate({ slug: update.slug })),
      );
      setExpanded(null);
      setShowAll(false);
    } catch (err) {
      console.error("Failed to clear product updates:", err);
    } finally {
      setClearing(false);
    }
  }, [dismissUpdate, updates]);

  if (!isAuthenticated) return null;
  if (updates === undefined) return null;

  const active = updates.filter((update) => !update.dismissed);
  if (active.length === 0) {
    if (updates.length === 0) return null;

    return (
      <section className="flex min-h-0 flex-col rounded-xl border border-border/60">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4 py-2">
          <h2 className="text-[13px] font-medium text-foreground">
            What&apos;s new
          </h2>
        </div>
        <div className="px-4 py-5 text-center">
          <p className="text-[13px] text-muted-foreground">
            You&apos;re all caught up.
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground/70">
            New product updates will show up here.
          </p>
        </div>
      </section>
    );
  }

  const hiddenCount = Math.max(active.length - PREVIEW_LIMIT, 0);
  const visible = showAll ? active : active.slice(0, PREVIEW_LIMIT);

  const handleSelect = (
    entry: ProductUpdateEntry,
    sourceRect: DOMRect | null,
  ) => {
    setExpanded({ entry, sourceRect });
  };

  return (
    <>
      <section className="flex min-h-0 flex-col rounded-xl border border-border/60">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4 py-2">
          <h2 className="text-[13px] font-medium text-foreground">What&apos;s new</h2>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>
              {active.length} update{active.length === 1 ? "" : "s"}
            </span>
            <span aria-hidden className="text-border">
              ·
            </span>
            <button
              type="button"
              onClick={handleClearAll}
              disabled={clearing}
              className="font-medium transition hover:text-foreground disabled:opacity-50"
            >
              {clearing ? "Clearing…" : "Clear all"}
            </button>
          </div>
        </div>

        <ul
          className={cn(
            "min-h-0",
            showAll && active.length > PREVIEW_LIMIT && "max-h-40 overflow-y-auto",
          )}
        >
          {visible.map((update, i) => (
            <UpdateRow
              key={update.slug}
              update={update}
              isLast={i === visible.length - 1 && hiddenCount === 0}
              onSelect={handleSelect}
              onDismiss={handleDismiss}
            />
          ))}
        </ul>

        {hiddenCount > 0 ? (
          <div className="border-t border-border/40">
            <button
              type="button"
              onClick={() => setShowAll((open) => !open)}
              className="flex w-full items-center justify-center gap-1 px-4 py-2 text-[11px] font-medium text-muted-foreground transition hover:bg-accent/40 hover:text-foreground"
            >
              {showAll
                ? "Show less"
                : `View ${hiddenCount} more update${hiddenCount === 1 ? "" : "s"}`}
            </button>
          </div>
        ) : null}
      </section>

      <ProductUpdateExpandedPanel
        entry={expanded?.entry ?? null}
        sourceRect={expanded?.sourceRect ?? null}
        onClose={() => setExpanded(null)}
        onDismiss={handleDismiss}
      />
    </>
  );
}
