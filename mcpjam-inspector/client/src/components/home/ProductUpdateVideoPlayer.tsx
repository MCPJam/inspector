import { parseVideoEmbed } from "./productUpdateVideo";
import type { ProductUpdateEntry } from "./productUpdateEntry";

export function ProductUpdateVideoPlayer({
  entry,
}: {
  entry: ProductUpdateEntry;
}) {
  if (entry.previewVideoUrl) {
    return (
      <div className="aspect-video w-full overflow-hidden rounded-lg bg-muted">
        <video
          src={entry.previewVideoUrl}
          poster={entry.videoPosterUrl}
          className="h-full w-full object-cover"
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
    <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-muted">
      <iframe
        key={entry.slug}
        src={`${embed.embedSrc}${
          embed.embedSrc.includes("?") ? "&" : "?"
        }autoplay=1`}
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
          className="absolute bottom-3 right-4 z-20 flex items-center gap-1.5 bg-popover text-popover-foreground hover:bg-accent text-xs font-medium px-3 py-1.5 rounded transition-colors"
        >
          Watch on <span className="font-bold">YouTube</span>
        </a>
      ) : null}
    </div>
  );
}
