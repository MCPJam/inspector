import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ExternalLink, XIcon, Play } from "lucide-react";
import { learnMoreContent } from "@/lib/learn-more-content";

interface LearnMoreExpandedPanelProps {
  tabId: string | null;
  sourceRect: DOMRect | null;
  onClose: () => void;
}

const PANEL_WIDTH = 900;
const EASING: [number, number, number, number] = [0.16, 1, 0.3, 1]; // ease-out-expo

function VideoThumbnail({ entry }: { entry: { title: string; videoUrl: string; videoThumbnail?: string } }) {
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const isMP4 = entry.videoUrl?.endsWith(".mp4");
  const isYouTube = entry.videoUrl?.includes("youtube.com/embed/");
  const youtubeId = isYouTube ? entry.videoUrl.split("/embed/")[1]?.split("?")[0] : null;
  const hasVideo = !!(entry.videoUrl);

  if (!hasVideo) {
    return (
      <div className="aspect-video w-full bg-muted flex items-center justify-center rounded-lg">
        <p className="text-muted-foreground text-sm">Video coming soon</p>
      </div>
    );
  }

  // Playing state: show the actual video/iframe
  if (playing) {
    return (
      <div className="aspect-video w-full overflow-hidden rounded-lg bg-black">
        {isMP4 ? (
          <video
            ref={videoRef}
            src={entry.videoUrl}
            className="h-full w-full"
            autoPlay
            loop
            muted
            playsInline
            preload="auto"
            controls
            title={`${entry.title} video`}
          />
        ) : (
          <iframe
            src={`${entry.videoUrl}${entry.videoUrl.includes("?") ? "&" : "?"}autoplay=1`}
            className="h-full w-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            title={`${entry.title} video`}
          />
        )}
      </div>
    );
  }

  // Thumbnail state (Notion-style): dark overlay + title + play button + Watch on YouTube
  const thumbnailSrc = entry.videoThumbnail
    ? entry.videoThumbnail
    : isMP4
      ? undefined
      : isYouTube && youtubeId
        ? `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg`
        : undefined;

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-neutral-900 group">
      {/* Background image / video poster */}
      {thumbnailSrc ? (
        <img
          src={thumbnailSrc}
          alt={`${entry.title} preview`}
          className="h-full w-full object-cover"
        />
      ) : isMP4 ? (
        <video
          src={entry.videoUrl}
          className="h-full w-full object-cover"
          muted
          playsInline
          preload="metadata"
        />
      ) : null}

      {/* Dark gradient overlay */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/40 to-black/30 group-hover:from-black/75 group-hover:via-black/45 group-hover:to-black/35 transition-colors" />

      {/* Title overlay (top-left) */}
      <div className="pointer-events-none absolute top-4 left-5">
        <p className="text-white text-lg font-semibold drop-shadow-md">
          {entry.title}
        </p>
        <p className="text-white/70 text-sm">MCPJam Inspector</p>
      </div>

      {/* Centered play button */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="rounded-full bg-white/90 group-hover:bg-white p-4 shadow-lg transition-colors">
          <Play className="h-6 w-6 text-black fill-black" />
        </div>
      </div>

      <button
        type="button"
        onClick={() => setPlaying(true)}
        className="absolute inset-0 z-10 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label={`Play ${entry.title} video`}
      />

      {/* Watch on YouTube badge (bottom-right) — only for YouTube videos */}
      {isYouTube && youtubeId && (
        <a
          href={`https://www.youtube.com/watch?v=${youtubeId}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-3 right-4 z-20 flex items-center gap-1.5 bg-black/70 hover:bg-black/90 text-white text-xs font-medium px-3 py-1.5 rounded transition-colors"
        >
          Watch on <span className="font-bold">YouTube</span>
        </a>
      )}
    </div>
  );
}

export function LearnMoreExpandedPanel({
  tabId,
  sourceRect,
  onClose,
}: LearnMoreExpandedPanelProps) {
  const entry = tabId ? learnMoreContent[tabId] : null;
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!tabId) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [tabId, onClose]);

  // Compute initial transform from sourceRect to final centered position
  const getInitialStyle = () => {
    if (!sourceRect) {
      // No source (first-visit auto-show) — just scale from center
      return { opacity: 0, scale: 0.95 };
    }

    const viewW = window.innerWidth;
    const viewH = window.innerHeight;

    // Final position: centered
    const finalX = (viewW - PANEL_WIDTH) / 2;
    const finalY = viewH * 0.1; // 10% from top

    // Offset from center to where the hover card was
    const deltaX = sourceRect.left - finalX;
    const deltaY = sourceRect.top - finalY;
    const scaleX = sourceRect.width / PANEL_WIDTH;

    return {
      opacity: 0.8,
      x: deltaX,
      y: deltaY,
      scale: scaleX,
      transformOrigin: "top left",
    };
  };

  return (
    <AnimatePresence>
      {entry && tabId && (
        <>
          {/* Overlay */}
          <motion.div
            key="learn-more-overlay"
            className="fixed inset-0 z-50 bg-black/50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25, ease: EASING }}
            onClick={onClose}
          />

          {/* Panel */}
          <motion.div
            ref={panelRef}
            key="learn-more-panel"
            className="fixed z-50 bg-background rounded-lg border shadow-lg overflow-y-auto overflow-x-hidden"
            style={{
              top: "10vh",
              left: "50%",
              marginLeft: -(PANEL_WIDTH / 2),
              width: PANEL_WIDTH,
              maxWidth: "calc(100vw - 2rem)",
              maxHeight: "80vh",
            }}
            initial={getInitialStyle()}
            animate={{
              opacity: 1,
              x: 0,
              y: 0,
              scale: 1,
              transformOrigin: "top left",
            }}
            exit={{
              opacity: 0,
              scale: 0.97,
              transition: { duration: 0.15, ease: EASING } as any,
            }}
            transition={{ duration: 0.35, ease: EASING }}
          >
            {/* Close button */}
            <button
              onClick={onClose}
              className="absolute top-3 right-3 z-10 rounded-full bg-background/80 backdrop-blur-sm p-1.5 opacity-70 transition-opacity hover:opacity-100 focus:outline-none"
            >
              <XIcon className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </button>

            {/* Title + docs link */}
            <div className="px-10 pt-8 pb-2 flex items-start justify-between gap-4">
              <h2 className="text-3xl font-bold leading-tight">
                {entry.title}
              </h2>
              <a
                href={entry.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 mt-1 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Docs
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>

            {/* Video / Thumbnail */}
            <div className="px-10 pt-2 pb-4">
              <VideoThumbnail entry={entry} />
            </div>

            {/* Description */}
            <div className="px-10 pb-8">
              <p className="text-base text-muted-foreground leading-relaxed">
                {entry.expandedDescription ?? entry.description}
              </p>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
