import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@mcpjam/design-system/sheet";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import { Play, X } from "lucide-react";
import { parseVideoEmbed } from "./productUpdateVideo";
import type { ProductUpdateEntry } from "./ProductUpdatesFeed";

function formatPublishDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

interface ProductUpdatesSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  updates: ProductUpdateEntry[];
  onDismiss: (slug: string) => void | Promise<void>;
}

export function ProductUpdatesSheet({
  open,
  onOpenChange,
  updates,
  onDismiss,
}: ProductUpdatesSheetProps) {
  const [playing, setPlaying] = useState<Set<string>>(new Set());

  const togglePlaying = (slug: string) => {
    setPlaying((prev) => {
      const next = new Set(prev);
      next.add(slug);
      return next;
    });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 sm:max-w-md"
      >
        <SheetHeader className="border-b border-border px-6 py-4">
          <SheetTitle className="text-[15px] tracking-[-0.005em]">
            What&apos;s new
          </SheetTitle>
          <SheetDescription className="text-[12.5px]">
            All releases and platform changes.
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <ol className="relative px-6 py-5">
            <span
              aria-hidden
              className="absolute left-[29px] top-7 bottom-6 w-px bg-border"
            />
            {updates.length === 0 ? (
              <p className="text-[12.5px] text-muted-foreground">
                No updates yet.
              </p>
            ) : null}
            {updates.map((update) => {
              const embed = update.videoUrl
                ? parseVideoEmbed(update.videoUrl)
                : null;
              const isInlineEmbeddable =
                embed && embed.provider !== "raw";
              const isPlaying = playing.has(update.slug);
              const poster =
                update.videoPosterUrl || embed?.posterSrc || undefined;

              return (
                <li
                  key={update.slug}
                  className={`group relative pb-6 pl-7 last:pb-0 ${
                    update.dismissed ? "opacity-60" : ""
                  }`}
                >
                  <span
                    aria-hidden
                    className={`absolute left-0 top-[5px] size-[11px] rounded-full ring-4 ring-background ${
                      update.isNew && !update.dismissed
                        ? "bg-primary"
                        : "bg-border"
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
                    ) : update.isNew && !update.dismissed ? (
                      <Badge className="h-4 px-1.5 text-[9.5px] tracking-wider">
                        NEW
                      </Badge>
                    ) : null}
                    {!update.dismissed ? (
                      <button
                        type="button"
                        aria-label={`Dismiss "${update.title}"`}
                        onClick={() => onDismiss(update.slug)}
                        className="ml-auto inline-flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 focus:opacity-100"
                      >
                        <X className="size-3" strokeWidth={2} />
                      </button>
                    ) : (
                      <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground">
                        Dismissed
                      </span>
                    )}
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

                  {isInlineEmbeddable ? (
                    <div className="mt-2">
                      {isPlaying ? (
                        <iframe
                          src={`${embed!.embedSrc}${
                            embed!.embedSrc.includes("?") ? "&" : "?"
                          }autoplay=1`}
                          title={update.title}
                          loading="lazy"
                          allow="autoplay; encrypted-media"
                          allowFullScreen
                          className="aspect-video w-full rounded-md border border-border"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => togglePlaying(update.slug)}
                          aria-label={`Play video for ${update.title}`}
                          className="group/play relative block aspect-video w-full overflow-hidden rounded-md border border-border bg-muted"
                        >
                          {poster ? (
                            <img
                              src={poster}
                              alt=""
                              loading="lazy"
                              className="absolute inset-0 size-full object-cover"
                            />
                          ) : null}
                          <span className="absolute inset-0 flex items-center justify-center bg-black/20 transition-colors group-hover/play:bg-black/30">
                            <span className="flex size-12 items-center justify-center rounded-full bg-white/90 text-foreground shadow-md transition-transform group-hover/play:scale-105">
                              <Play
                                className="size-5 translate-x-[1px]"
                                strokeWidth={2}
                                fill="currentColor"
                              />
                            </span>
                          </span>
                        </button>
                      )}
                    </div>
                  ) : embed && embed.provider === "raw" ? (
                    <div className="mt-2">
                      <Button
                        asChild
                        variant="outline"
                        size="sm"
                        className="h-6 gap-1 px-2 text-[11px]"
                      >
                        <a
                          href={embed.embedSrc}
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
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
