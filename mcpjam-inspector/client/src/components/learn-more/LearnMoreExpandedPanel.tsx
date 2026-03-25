import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ExternalLink, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { learnMoreContent } from "@/lib/learn-more-content";

interface LearnMoreExpandedPanelProps {
  tabId: string | null;
  sourceRect: DOMRect | null;
  onClose: () => void;
}

const PANEL_WIDTH = 720;
const EASING: [number, number, number, number] = [0.16, 1, 0.3, 1]; // ease-out-expo

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
            className="fixed z-50 bg-background rounded-lg border shadow-lg p-6 overflow-y-auto"
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
              className="absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:outline-none"
            >
              <XIcon className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </button>

            {/* Header */}
            <div className="mb-4">
              <h2 className="text-lg font-semibold leading-none pb-1">
                {entry.title}
              </h2>
              <p className="text-muted-foreground text-sm">
                {entry.description}
              </p>
            </div>

            {/* Video */}
            {entry.videoUrl ? (
              <div className="aspect-video w-full overflow-hidden rounded-md bg-muted mb-4">
                {entry.videoUrl.endsWith(".mp4") ? (
                  <video
                    src={entry.videoUrl}
                    className="h-full w-full"
                    autoPlay
                    loop
                    muted
                    playsInline
                    preload="auto"
                    title={`${entry.title} video`}
                  />
                ) : (
                  <iframe
                    src={entry.videoUrl}
                    className="h-full w-full"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                    title={`${entry.title} video`}
                  />
                )}
              </div>
            ) : (
              <div className="aspect-video w-full overflow-hidden rounded-md bg-muted flex items-center justify-center mb-4">
                <p className="text-muted-foreground text-sm">
                  Video coming soon
                </p>
              </div>
            )}

            {/* Docs link */}
            <div className="flex justify-end">
              <Button variant="outline" size="sm" asChild>
                <a
                  href={entry.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Read the docs
                  <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                </a>
              </Button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
