import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ExternalLink, XIcon } from "lucide-react";
import { parseVideoEmbed } from "./productUpdateVideo";
import type { ProductUpdateEntry } from "./productUpdateEntry";

interface ProductUpdateExpandedPanelProps {
  entry: ProductUpdateEntry | null;
  sourceRect: DOMRect | null;
  onClose: () => void;
  onDismiss?: (slug: string) => void;
}

const PANEL_WIDTH = 900;
const PANEL_GUTTER = 16;
const EASING: [number, number, number, number] = [0.16, 1, 0.3, 1];

function getViewportSize() {
  if (typeof window === "undefined") {
    return { width: PANEL_WIDTH + PANEL_GUTTER * 2, height: 900 };
  }
  return { width: window.innerWidth, height: window.innerHeight };
}

function getPanelLayout(viewWidth: number, viewHeight: number) {
  const width = Math.min(
    PANEL_WIDTH,
    Math.max(viewWidth - PANEL_GUTTER * 2, 0),
  );
  const left = Math.max((viewWidth - width) / 2, PANEL_GUTTER);
  const top = Math.max(viewHeight * 0.1, PANEL_GUTTER);
  const maxHeight = Math.max(viewHeight - top - PANEL_GUTTER, 0);
  return { left, top, width, maxHeight };
}

function ExpandedVideo({ entry }: { entry: ProductUpdateEntry }) {
  if (entry.previewVideoUrl) {
    return (
      <div className="aspect-video w-full overflow-hidden rounded-lg bg-black">
        <video
          src={entry.previewVideoUrl}
          poster={entry.videoPosterUrl}
          className="h-full w-full"
          autoPlay
          loop
          muted
          playsInline
          preload="auto"
          controls
        />
      </div>
    );
  }

  const embed = entry.videoUrl ? parseVideoEmbed(entry.videoUrl) : null;
  const youtubeId =
    embed?.provider === "youtube"
      ? embed.embedSrc.split("/embed/")[1]?.split("?")[0]
      : null;
  const isInlineEmbeddable = embed && embed.provider !== "raw";

  if (!isInlineEmbeddable) {
    return (
      <div className="aspect-video w-full bg-muted flex items-center justify-center rounded-lg">
        <p className="text-muted-foreground text-sm">No video available</p>
      </div>
    );
  }

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
      <iframe
        key={entry.slug}
        src={`${embed.embedSrc}${embed.embedSrc.includes("?") ? "&" : "?"}autoplay=1`}
        className="absolute inset-0 h-full w-full"
        allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        title={`${entry.title} video`}
      />
      {youtubeId ? (
        <a
          href={`https://www.youtube.com/watch?v=${youtubeId}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-3 right-4 z-20 flex items-center gap-1.5 bg-black/70 hover:bg-black/90 text-white text-xs font-medium px-3 py-1.5 rounded transition-colors"
        >
          Watch on <span className="font-bold">YouTube</span>
        </a>
      ) : null}
    </div>
  );
}

export function ProductUpdateExpandedPanel({
  entry,
  sourceRect,
  onClose,
  onDismiss,
}: ProductUpdateExpandedPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(getViewportSize);
  const panelLayout = getPanelLayout(viewport.width, viewport.height);

  useEffect(() => {
    if (!entry) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [entry, onClose]);

  useEffect(() => {
    if (!entry) return;
    const updateViewport = () => setViewport(getViewportSize());
    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, [entry]);

  const getInitialStyle = () => {
    if (!sourceRect) return { opacity: 0, scale: 0.95 };
    const deltaX = sourceRect.left - panelLayout.left;
    const deltaY = sourceRect.top - panelLayout.top;
    const scaleX =
      panelLayout.width > 0 ? sourceRect.width / panelLayout.width : 1;
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
      {entry ? (
        <>
          <motion.div
            key="product-update-overlay"
            className="fixed inset-0 z-50 bg-black/50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25, ease: EASING }}
            onClick={onClose}
          />
          <motion.div
            ref={panelRef}
            key="product-update-panel"
            className="fixed z-50 bg-background rounded-lg border shadow-lg overflow-y-auto overflow-x-hidden"
            style={{
              top: panelLayout.top,
              left: panelLayout.left,
              width: panelLayout.width,
              maxHeight: panelLayout.maxHeight,
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
              transition: { duration: 0.15, ease: EASING },
            }}
            transition={{ duration: 0.35, ease: EASING }}
          >
            <button
              onClick={onClose}
              className="absolute top-3 right-3 z-10 rounded-full bg-background/80 backdrop-blur-sm p-1.5 opacity-70 transition-opacity hover:opacity-100 focus:outline-none"
            >
              <XIcon className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </button>

            <div className="px-10 pt-8 pb-2 flex items-start justify-between gap-4">
              <h2 className="text-3xl font-bold leading-tight">
                {entry.title}
              </h2>
              {entry.href ? (
                <a
                  href={entry.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 mt-1 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  Docs
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              ) : null}
            </div>

            <div className="px-10 pt-2 pb-4">
              <ExpandedVideo entry={entry} />
            </div>

            <div className="px-10 pb-8">
              <p className="text-base text-muted-foreground leading-relaxed whitespace-pre-line">
                {entry.body}
              </p>
              {onDismiss ? (
                <div className="mt-6 flex justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      onDismiss(entry.slug);
                      onClose();
                    }}
                    className="rounded-full border border-border px-4 py-1.5 text-sm font-medium text-foreground transition hover:bg-accent"
                  >
                    Got it
                  </button>
                </div>
              ) : null}
            </div>
          </motion.div>
        </>
      ) : null}
    </AnimatePresence>
  );
}
