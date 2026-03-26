import { useRef, useState } from "react";
import { ExternalLink, Play } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { learnMoreContent } from "@/lib/learn-more-content";

interface LearnMoreModalProps {
  tabId: string | null;
  onClose: () => void;
}

function ModalVideoThumbnail({ entry }: { entry: { title: string; videoUrl: string; videoThumbnail?: string } }) {
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

  const thumbnailSrc = isMP4
    ? undefined
    : isYouTube && youtubeId
      ? `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg`
      : entry.videoThumbnail;

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-neutral-900 group">
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

      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/40 to-black/30 group-hover:from-black/75 group-hover:via-black/45 group-hover:to-black/35 transition-colors" />

      <div className="pointer-events-none absolute top-4 left-5">
        <p className="text-white text-lg font-semibold drop-shadow-md">
          {entry.title}
        </p>
        <p className="text-white/70 text-sm">MCPJam Inspector</p>
      </div>

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

export function LearnMoreModal({ tabId, onClose }: LearnMoreModalProps) {
  const entry = tabId ? learnMoreContent[tabId] : null;

  if (!entry) return null;

  return (
    <Dialog open={!!tabId} onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-5xl p-0 overflow-hidden">
        {/* Title + docs link */}
        <div className="px-10 pt-8 pb-0 flex items-start justify-between gap-4">
          <DialogHeader className="p-0">
            <DialogTitle className="text-3xl font-bold">{entry.title}</DialogTitle>
            <DialogDescription className="text-base leading-relaxed mt-2">
              {entry.expandedDescription ?? entry.description}
            </DialogDescription>
          </DialogHeader>
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

        {/* Video thumbnail — Notion style */}
        <div className="px-20 pt-2 pb-8">
          <ModalVideoThumbnail entry={entry} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
