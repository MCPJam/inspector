import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@mcpjam/design-system/sheet";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
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

interface VideoPreviewProps {
  update: ProductUpdateEntry;
  onOpen: () => void;
}

function VideoPreview({ update, onOpen }: VideoPreviewProps) {
  const embed = update.videoUrl ? parseVideoEmbed(update.videoUrl) : null;
  const hasPreviewMp4 = !!update.previewVideoUrl;
  const poster = update.videoPosterUrl || embed?.posterSrc || undefined;
  const isInlineEmbeddable = embed && embed.provider !== "raw";

  // No preview to show, no full video to open: render nothing.
  if (!hasPreviewMp4 && !isInlineEmbeddable && embed?.provider !== "raw") {
    return null;
  }

  // Raw / non-embeddable URL: keep the existing "Watch" link behavior, no
  // modal — we can't reliably autoplay or iframe an arbitrary URL.
  if (!hasPreviewMp4 && embed?.provider === "raw") {
    return (
      <div className="mt-2">
        <Button
          asChild
          variant="outline"
          size="sm"
          className="h-6 gap-1 px-2 text-[11px]"
        >
          <a href={embed.embedSrc} target="_blank" rel="noopener noreferrer">
            <Play className="size-3" strokeWidth={2} />
            Watch
          </a>
        </Button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Play video for ${update.title}`}
      className="group/play relative mt-2 block aspect-video w-full overflow-hidden rounded-md border border-border bg-muted"
    >
      {hasPreviewMp4 ? (
        <video
          src={update.previewVideoUrl}
          poster={poster}
          className="absolute inset-0 size-full object-cover"
          autoPlay
          loop
          muted
          playsInline
          preload="auto"
        />
      ) : poster ? (
        <img
          src={poster}
          alt=""
          loading="lazy"
          className="absolute inset-0 size-full object-cover"
        />
      ) : null}
      {/* Play affordance: faded over the autoplay preview, prominent over a
          static poster. */}
      <span
        className={`absolute inset-0 flex items-center justify-center transition-colors ${
          hasPreviewMp4
            ? "bg-black/0 group-hover/play:bg-black/20"
            : "bg-black/20 group-hover/play:bg-black/30"
        }`}
      >
        <span
          className={`flex size-12 items-center justify-center rounded-full bg-white/90 text-foreground shadow-md transition-all group-hover/play:scale-105 ${
            hasPreviewMp4
              ? "opacity-0 group-hover/play:opacity-100"
              : "opacity-100"
          }`}
        >
          <Play
            className="size-5 translate-x-[1px]"
            strokeWidth={2}
            fill="currentColor"
          />
        </span>
      </span>
    </button>
  );
}

interface VideoModalProps {
  update: ProductUpdateEntry | null;
  onClose: () => void;
}

function VideoModal({ update, onClose }: VideoModalProps) {
  const embed = update?.videoUrl ? parseVideoEmbed(update.videoUrl) : null;
  const youtubeId =
    embed?.provider === "youtube"
      ? embed.embedSrc.split("/embed/")[1]?.split("?")[0]
      : null;

  return (
    <Dialog
      open={!!update}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        showCloseButton
        className="max-w-3xl gap-0 overflow-hidden border-0 bg-neutral-950 p-0 sm:max-w-3xl"
      >
        <DialogTitle className="sr-only">
          {update?.title ?? "Video"}
        </DialogTitle>
        <div className="relative aspect-video w-full bg-black">
          {embed && embed.provider !== "raw" ? (
            <iframe
              key={update?.slug}
              src={`${embed.embedSrc}${embed.embedSrc.includes("?") ? "&" : "?"}autoplay=1`}
              title={update?.title ?? "Video"}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              className="absolute inset-0 size-full"
            />
          ) : null}

          {youtubeId ? (
            <a
              href={`https://www.youtube.com/watch?v=${youtubeId}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="absolute bottom-3 right-3 z-10 flex items-center gap-1.5 rounded bg-black/70 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-black/90"
            >
              Watch on <span className="font-bold">YouTube</span>
            </a>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ProductUpdatesSheet({
  open,
  onOpenChange,
  updates,
  onDismiss,
}: ProductUpdatesSheetProps) {
  const [activeVideo, setActiveVideo] = useState<ProductUpdateEntry | null>(
    null,
  );

  // Close the video modal when the sheet closes so reopening starts clean.
  useEffect(() => {
    if (!open) setActiveVideo(null);
  }, [open]);

  return (
    <>
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
              {updates.map((update) => (
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
                        className="ml-auto inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100"
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

                  <VideoPreview
                    update={update}
                    onOpen={() => setActiveVideo(update)}
                  />
                </li>
              ))}
            </ol>
          </ScrollArea>
        </SheetContent>
      </Sheet>

      <VideoModal
        update={activeVideo}
        onClose={() => setActiveVideo(null)}
      />
    </>
  );
}
