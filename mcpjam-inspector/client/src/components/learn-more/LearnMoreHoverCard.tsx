import { useRef, useState } from "react";
import { Maximize2 } from "lucide-react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { learnMoreContent } from "@/lib/learn-more-content";

interface LearnMoreHoverCardProps {
  tabId: string;
  children: React.ReactNode;
  onExpand: (tabId: string, sourceRect: DOMRect | null) => void;
}

export function LearnMoreHoverCard({
  tabId,
  children,
  onExpand,
}: LearnMoreHoverCardProps) {
  const entry = learnMoreContent[tabId];
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  if (!entry) return <>{children}</>;

  const handleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = wrapperRef.current?.getBoundingClientRect() ?? null;
    // Close hover card instantly before expanding
    setOpen(false);
    // Small delay to let hover card unmount before panel mounts
    requestAnimationFrame(() => {
      onExpand(tabId, rect);
    });
  };

  return (
    <HoverCard openDelay={400} closeDelay={200} open={open} onOpenChange={setOpen}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent side="right" sideOffset={8} className="w-80">
        <div ref={wrapperRef}>
          <div className="relative mb-3 overflow-hidden rounded-md bg-muted">
            <button
              onClick={handleExpand}
              className="absolute top-1.5 right-1.5 z-10 p-1 rounded-sm bg-black/40 text-white hover:bg-black/60 transition-colors"
              aria-label="Expand"
            >
              <Maximize2 className="h-3 w-3" />
            </button>
            {entry.videoUrl?.endsWith(".mp4") ? (
              <video
                src={entry.videoUrl}
                className="w-full h-auto"
                autoPlay
                loop
                muted
                playsInline
                preload="auto"
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
          </div>

          <p className="text-sm text-muted-foreground">
            {entry.description}
          </p>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
