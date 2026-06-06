import { useEffect, useRef, useState } from "react";
import { Maximize2, Play } from "lucide-react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@mcpjam/design-system/hover-card";
import { parseVideoEmbed } from "./productUpdateVideo";
import type { ProductUpdateEntry } from "./productUpdateEntry";

// Mirrors LearnMoreHoverCard's preload-as-blob trick so the preview MP4
// starts paying download cost on first hover rather than at every popover
// open. Kept module-local — different feeds shouldn't share a cache key
// across components.
const blobCache: Record<string, string> = {};

function preloadBlob(url: string) {
  if (
    typeof window === "undefined" ||
    typeof fetch !== "function" ||
    typeof URL.createObjectURL !== "function" ||
    url in blobCache
  ) {
    return;
  }
  blobCache[url] = url;
  fetch(url)
    .then((res) => res.blob())
    .then((blob) => {
      blobCache[url] = URL.createObjectURL(blob);
    })
    .catch(() => {});
}

interface ProductUpdateHoverCardProps {
  entry: ProductUpdateEntry;
  children: React.ReactNode;
  onExpand: (entry: ProductUpdateEntry, sourceRect: DOMRect | null) => void;
}

export function ProductUpdateHoverCard({
  entry,
  children,
  onExpand,
}: ProductUpdateHoverCardProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [open, setOpen] = useState(false);

  // Reset playback whenever the popover opens so each hover starts at t=0.
  useEffect(() => {
    if (open && videoRef.current) {
      videoRef.current.currentTime = 0;
      videoRef.current.play().catch(() => {});
    }
  }, [open]);

  useEffect(() => {
    if (entry.previewVideoUrl) preloadBlob(entry.previewVideoUrl);
  }, [entry.previewVideoUrl]);

  const embed = entry.videoUrl ? parseVideoEmbed(entry.videoUrl) : null;
  const youtubeThumb =
    embed?.provider === "youtube"
      ? `https://img.youtube.com/vi/${embed.embedSrc.split("/embed/")[1].split("?")[0]}/hqdefault.jpg`
      : null;
  const hasPreviewMp4 = !!entry.previewVideoUrl;

  const handleExpand = () => {
    const rect = wrapperRef.current?.getBoundingClientRect() ?? null;
    setOpen(false);
    requestAnimationFrame(() => onExpand(entry, rect));
  };

  return (
    <HoverCard openDelay={400} closeDelay={200} open={open} onOpenChange={setOpen}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent side="bottom" sideOffset={8} className="w-80">
        <div ref={wrapperRef}>
          <div className="relative mb-3 overflow-hidden rounded-md bg-muted group">
            {hasPreviewMp4 ? (
              <video
                ref={videoRef}
                src={blobCache[entry.previewVideoUrl!] ?? entry.previewVideoUrl}
                poster={entry.videoPosterUrl}
                className="w-full h-auto"
                autoPlay
                loop
                muted
                playsInline
                preload="auto"
              />
            ) : youtubeThumb ? (
              <img
                src={youtubeThumb}
                alt={`${entry.title} preview`}
                className="w-full h-auto"
              />
            ) : entry.videoPosterUrl ? (
              <img
                src={entry.videoPosterUrl}
                alt={`${entry.title} preview`}
                className="w-full h-auto"
              />
            ) : (
              <div className="aspect-video flex items-center justify-center">
                <p className="text-muted-foreground text-xs">Preview</p>
              </div>
            )}
            {/* Play affordance shown only when the static thumbnail is what's
                under the cursor — autoplaying preview doesn't need one. */}
            {!hasPreviewMp4 && (youtubeThumb || entry.videoPosterUrl) ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors">
                <div className="rounded-full bg-white/90 p-2">
                  <Play className="h-4 w-4 text-black fill-black" />
                </div>
              </div>
            ) : null}
            <button
              type="button"
              onClick={handleExpand}
              className="absolute inset-0 z-10 cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label={`Open ${entry.title}`}
            />
          </div>

          <div className="flex items-end justify-between gap-2">
            <p className="text-sm text-muted-foreground line-clamp-3">
              {entry.body}
            </p>
            <button
              type="button"
              onClick={handleExpand}
              className="shrink-0 p-1 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
              aria-label={`Expand ${entry.title}`}
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
