import { useEffect, useRef, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@mcpjam/design-system/card";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { Newspaper, Play, X } from "lucide-react";
import { parseVideoEmbed } from "./productUpdateVideo";
import { ProductUpdatesSheet } from "./ProductUpdatesSheet";

export interface ProductUpdateEntry {
  _id: string;
  slug: string;
  publishAt: number;
  title: string;
  body: string;
  tag?: string;
  href?: string;
  videoUrl?: string;
  videoPosterUrl?: string;
  previewVideoUrl?: string;
  dismissed: boolean;
  isNew: boolean;
}

function formatPublishDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  });
}

export function ProductUpdatesFeed() {
  const { isAuthenticated } = useConvexAuth();
  const updates = useQuery(
    "productUpdates:listVisibleUpdates" as any,
    isAuthenticated ? ({} as any) : "skip"
  ) as ProductUpdateEntry[] | undefined;

  const dismissUpdate = useMutation("productUpdates:dismissUpdate" as any);
  const initialize = useMutation(
    "productUpdates:initializeIfNeeded" as any
  );

  const [sheetOpen, setSheetOpen] = useState(false);
  const initRef = useRef(false);

  useEffect(() => {
    if (!isAuthenticated || initRef.current) return;
    initRef.current = true;
    initialize({}).catch((err) => {
      // Reset the guard so a transient failure can be retried on next mount.
      initRef.current = false;
      console.error("Failed to initialize product updates:", err);
    });
  }, [isAuthenticated, initialize]);

  if (!isAuthenticated) return null;
  // Hold render until the query has resolved at least once, so the card
  // doesn't flash an empty state before the data arrives.
  if (updates === undefined) return null;

  const visible = updates.filter((u) => !u.dismissed);
  const top = visible.slice(0, 5);
  const newCount = visible.filter((u) => u.isNew).length;
  const hasAny = updates.length > 0;

  const handleDismiss = async (slug: string) => {
    try {
      await dismissUpdate({ slug });
    } catch (err) {
      console.error("Failed to dismiss product update:", err);
    }
  };

  return (
    <>
      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="px-6 pb-3 pt-5">
          <CardTitle className="flex items-center gap-2 text-[15px] tracking-[-0.005em]">
            <Newspaper
              className="size-4 text-muted-foreground"
              strokeWidth={1.75}
            />
            What&apos;s new
            {newCount > 0 ? (
              <Badge className="h-4 px-1.5 text-[9.5px] tracking-wider">
                {newCount} NEW
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription className="text-[12.5px]">
            Recent releases and platform changes.
          </CardDescription>
        </CardHeader>

        <CardContent className="px-6 pb-4 pt-3">
          {top.length === 0 ? (
            <p className="py-2 text-[12.5px] text-muted-foreground">
              {hasAny
                ? "You’re all caught up."
                : "No updates yet. Releases and platform changes will show up here."}
            </p>
          ) : (
            <ol className="relative">
              {/* timeline rail */}
              <span
                aria-hidden
                className="absolute left-[5px] top-1.5 bottom-2 w-px bg-border"
              />
              {top.map((update) => {
              const embed = update.videoUrl
                ? parseVideoEmbed(update.videoUrl)
                : null;
              return (
                <li
                  key={update.slug}
                  className="group relative pb-5 pl-7 last:pb-0"
                >
                  <span
                    aria-hidden
                    className={`absolute left-0 top-[5px] size-[11px] rounded-full ring-4 ring-card ${
                      update.isNew ? "bg-primary" : "bg-border"
                    }`}
                  />
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                      {formatPublishDate(update.publishAt)}
                    </span>
                    {update.tag ? (
                      <Badge className="h-4 px-1.5 text-[9.5px] tracking-wider">
                        {update.tag}
                      </Badge>
                    ) : update.isNew ? (
                      <Badge className="h-4 px-1.5 text-[9.5px] tracking-wider">
                        NEW
                      </Badge>
                    ) : null}
                    <button
                      type="button"
                      aria-label={`Dismiss "${update.title}"`}
                      onClick={() => handleDismiss(update.slug)}
                      className="ml-auto inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100"
                    >
                      <X className="size-3" strokeWidth={2} />
                    </button>
                  </div>
                  {update.href ? (
                    <a
                      href={update.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 block text-[14px] font-semibold tracking-[-0.005em] text-foreground hover:underline"
                    >
                      {update.title}
                    </a>
                  ) : (
                    <p className="mt-1 text-[14px] font-semibold tracking-[-0.005em] text-foreground">
                      {update.title}
                    </p>
                  )}
                  <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                    {update.body}
                  </p>
                  {embed ? (
                    <div className="mt-2">
                      <Button
                        asChild
                        variant="outline"
                        size="sm"
                        className="h-6 gap-1 px-2 text-[11px]"
                      >
                        <a
                          href={
                            embed.provider === "raw"
                              ? embed.embedSrc
                              : (update.videoUrl as string)
                          }
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <Play className="size-3" strokeWidth={2} />
                          Watch
                        </a>
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
              })}
            </ol>
          )}

          {hasAny ? (
            <div className="mt-3 flex justify-end border-t border-border pt-3">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[12px] text-muted-foreground hover:text-foreground"
                onClick={() => setSheetOpen(true)}
              >
                See all &rarr;
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <ProductUpdatesSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        updates={updates ?? []}
        onDismiss={handleDismiss}
      />
    </>
  );
}
