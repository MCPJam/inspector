import { useRef, useState, useEffect } from "react";
import { Maximize2, Play } from "lucide-react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { learnMoreContent } from "@/lib/learn-more-content";

// Preload all preview videos into blob URLs so they play instantly on hover
const blobCache: Record<string, string> = {};
if (
  typeof window !== "undefined" &&
  typeof fetch === "function" &&
  typeof URL.createObjectURL === "function"
) {
  Object.values(learnMoreContent).forEach((entry) => {
    if (entry.previewVideoUrl && !(entry.previewVideoUrl in blobCache)) {
      const url = entry.previewVideoUrl;
      blobCache[url] = url; // fallback to original URL initially
      fetch(url)
        .then((res) => res.blob())
        .then((blob) => {
          blobCache[url] = URL.createObjectURL(blob);
        })
        .catch(() => {}); // silently fall back to original URL
    }
  });
}

interface LearnMoreHoverCardProps {
  tabId: string;
  children: React.ReactNode;
  onExpand: (tabId: string, sourceRect: DOMRect | null) => void;
  triggerTooltip?: string;
  triggerTooltipDelayMs?: number;
  /** Message shown inside the hover card for disabled items (e.g. "Available locally") */
  disabledMessage?: string;
}

export function LearnMoreHoverCard({
  tabId,
  children,
  onExpand,
  triggerTooltip,
  triggerTooltipDelayMs,
  disabledMessage,
}: LearnMoreHoverCardProps) {
  const entry = learnMoreContent[tabId];
  const wrapperRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [open, setOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const handoffTimerRef = useRef<number | null>(null);

  const clearHandoffTimer = () => {
    if (handoffTimerRef.current !== null) {
      window.clearTimeout(handoffTimerRef.current);
      handoffTimerRef.current = null;
    }
  };

  useEffect(() => {
    if (open && videoRef.current) {
      videoRef.current.currentTime = 0;
      videoRef.current.play().catch(() => {});
    }
  }, [open]);

  useEffect(() => {
    return () => {
      clearHandoffTimer();
    };
  }, []);

  if (!entry) return <>{children}</>;

  const shouldShowTooltipFirst =
    !!triggerTooltip && triggerTooltipDelayMs !== undefined;

  const handleOpenChange = (nextOpen: boolean) => {
    clearHandoffTimer();

    if (!shouldShowTooltipFirst) {
      setOpen(nextOpen);
      setTooltipOpen(false);
      return;
    }

    if (!nextOpen) {
      setTooltipOpen(false);
      setOpen(false);
      return;
    }

    setTooltipOpen(true);
    setOpen(false);
    handoffTimerRef.current = window.setTimeout(() => {
      setTooltipOpen(false);
      setOpen(true);
      handoffTimerRef.current = null;
    }, triggerTooltipDelayMs);
  };

  const handleExpand = () => {
    const rect = wrapperRef.current?.getBoundingClientRect() ?? null;
    setOpen(false);
    setTooltipOpen(false);
    clearHandoffTimer();
    requestAnimationFrame(() => {
      onExpand(tabId, rect);
    });
  };

  const hasPreview = !!entry.previewVideoUrl;
  const hasThumbnail =
    hasPreview ||
    entry.videoUrl?.endsWith(".mp4") ||
    entry.videoUrl?.includes("youtube.com/embed/") ||
    entry.videoThumbnail;

  return (
    <HoverCard
      openDelay={shouldShowTooltipFirst ? 0 : 400}
      closeDelay={200}
      open={open}
      onOpenChange={handleOpenChange}
    >
      {shouldShowTooltipFirst ? (
        <Tooltip open={tooltipOpen}>
          <TooltipTrigger asChild>
            <HoverCardTrigger asChild>{children}</HoverCardTrigger>
          </TooltipTrigger>
          <TooltipContent side="right" align="center">
            {triggerTooltip}
          </TooltipContent>
        </Tooltip>
      ) : (
        <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      )}
      <HoverCardContent side="right" sideOffset={8} className="w-72">
        <div ref={wrapperRef}>
          <div className="relative mb-3 overflow-hidden rounded-md bg-muted group">
            {hasPreview ? (
              <video
                ref={videoRef}
                src={blobCache[entry.previewVideoUrl!] ?? entry.previewVideoUrl}
                className="w-full h-auto"
                autoPlay
                loop
                muted
                playsInline
                preload="auto"
              />
            ) : entry.videoUrl?.endsWith(".mp4") ? (
              <video
                src={entry.videoUrl}
                className="w-full h-auto"
                muted
                playsInline
                preload="metadata"
              />
            ) : entry.videoUrl?.includes("youtube.com/embed/") ? (
              <img
                src={`https://img.youtube.com/vi/${entry.videoUrl.split("/embed/")[1].split("?")[0]}/hqdefault.jpg`}
                alt={`${entry.title} preview`}
                className="w-full h-auto"
              />
            ) : entry.videoThumbnail ? (
              <img
                src={entry.videoThumbnail}
                alt={`${entry.title} preview`}
                className="w-full h-auto"
              />
            ) : (
              <div className="aspect-video flex items-center justify-center">
                <p className="text-muted-foreground text-xs">Preview</p>
              </div>
            )}
            {hasThumbnail && !hasPreview && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors">
                <div className="rounded-full bg-white/90 p-2">
                  <Play className="h-4 w-4 text-black fill-black" />
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={handleExpand}
              className="absolute inset-0 z-10 cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label={`Open ${entry.title} learn more`}
            />
          </div>

          {disabledMessage && (
            <p className="text-xs text-muted-foreground/80 italic mb-2">
              {disabledMessage}
            </p>
          )}

          <div className="flex items-end justify-between gap-2">
            <p className="text-sm text-muted-foreground">{entry.description}</p>
            <button
              type="button"
              onClick={handleExpand}
              className="shrink-0 p-1 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
              aria-label={`Learn more about ${entry.title}`}
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
