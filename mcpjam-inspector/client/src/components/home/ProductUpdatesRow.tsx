import { useEffect, useRef, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { Newspaper, Maximize2 } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { Card, CardContent } from "@mcpjam/design-system/card";
import { ProductUpdateHoverCard } from "./ProductUpdateHoverCard";
import { ProductUpdateExpandedPanel } from "./ProductUpdateExpandedPanel";
import type { ProductUpdateEntry } from "./productUpdateEntry";

function formatPublishDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
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

  const [expanded, setExpanded] = useState<{
    entry: ProductUpdateEntry;
    sourceRect: DOMRect | null;
  } | null>(null);
  const initRef = useRef(false);

  useEffect(() => {
    if (!isAuthenticated || initRef.current) return;
    initRef.current = true;
    initialize({}).catch((err) => {
      initRef.current = false;
      console.error("Failed to initialize product updates:", err);
    });
  }, [isAuthenticated, initialize]);

  if (!isAuthenticated) return null;
  if (updates === undefined) return null;
  if (updates.length === 0) return null;

  // Show the freshest few. The expanded panel reaches every entry, but the
  // row stays compact so it doesn't push Recommended Servers below the fold.
  const top = updates.slice(0, 4);

  return (
    <>
      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-2">
            <Newspaper
              className="size-4 text-muted-foreground"
              strokeWidth={1.75}
            />
            <h2 className="text-[15px] font-semibold tracking-[-0.005em]">
              What&apos;s new
            </h2>
          </div>
          <p className="text-[12.5px] text-muted-foreground">
            Recent releases and platform changes.
          </p>
        </div>

        <CardContent className="grid gap-4 px-6 py-5 sm:grid-cols-2 lg:grid-cols-4">
          {top.map((update) => (
            <ProductUpdateHoverCard
              key={update.slug}
              entry={update}
              onExpand={(entry, sourceRect) =>
                setExpanded({ entry, sourceRect })
              }
            >
              <button
                type="button"
                onClick={(e) =>
                  setExpanded({
                    entry: update,
                    sourceRect: e.currentTarget.getBoundingClientRect(),
                  })
                }
                className="group flex h-full w-full flex-col items-stretch gap-2 rounded-md border border-border bg-card p-4 text-left transition-colors hover:border-foreground/20 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10.5px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                    {formatPublishDate(update.publishAt)}
                  </span>
                  {update.tag ? (
                    <Badge className="h-4 px-1.5 text-[9.5px] tracking-wider">
                      {update.tag}
                    </Badge>
                  ) : update.isNew && !update.dismissed ? (
                    <Badge className="h-4 px-1.5 text-[9.5px] tracking-wider">
                      NEW
                    </Badge>
                  ) : null}
                </div>
                <span className="text-[14px] font-semibold leading-snug tracking-[-0.005em] text-foreground">
                  {update.title}
                </span>
                <span className="line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground">
                  {update.body}
                </span>
                <span className="mt-auto flex items-center justify-end pt-1 text-muted-foreground/70 transition-colors group-hover:text-foreground">
                  <Maximize2 className="size-3.5" />
                </span>
              </button>
            </ProductUpdateHoverCard>
          ))}
        </CardContent>
      </Card>

      <ProductUpdateExpandedPanel
        entry={expanded?.entry ?? null}
        sourceRect={expanded?.sourceRect ?? null}
        onClose={() => setExpanded(null)}
      />
    </>
  );
}
