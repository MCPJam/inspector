import { ExternalLink } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { learnMoreContent } from "@/lib/learn-more-content";

interface LearnMoreModalProps {
  tabId: string | null;
  onClose: () => void;
}

export function LearnMoreModal({ tabId, onClose }: LearnMoreModalProps) {
  const entry = tabId ? learnMoreContent[tabId] : null;

  if (!entry) return null;

  return (
    <Dialog open={!!tabId} onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{entry.title}</DialogTitle>
          <DialogDescription>{entry.description}</DialogDescription>
        </DialogHeader>

        {entry.videoUrl && (
          <div className="aspect-video w-full overflow-hidden rounded-md bg-muted">
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
        )}

        {!entry.videoUrl && (
          <div className="aspect-video w-full overflow-hidden rounded-md bg-muted flex items-center justify-center">
            <p className="text-muted-foreground text-sm">
              Video coming soon
            </p>
          </div>
        )}

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
      </DialogContent>
    </Dialog>
  );
}
