export type VideoProvider = "youtube" | "loom" | "vimeo" | "raw";

export interface VideoEmbed {
  provider: VideoProvider;
  embedSrc: string;
  posterSrc?: string;
}

function extractYouTubeId(url: string): string | null {
  // youtube.com/watch?v=<id>
  const watchMatch = url.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
  if (watchMatch) return watchMatch[1];
  // youtu.be/<id>
  const shortMatch = url.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  if (shortMatch) return shortMatch[1];
  // youtube.com/shorts/<id>
  const shortsMatch = url.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/);
  if (shortsMatch) return shortsMatch[1];
  // youtube.com/embed/<id>
  const embedMatch = url.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{6,})/);
  if (embedMatch) return embedMatch[1];
  return null;
}

function extractLoomId(url: string): string | null {
  const m = url.match(/loom\.com\/(?:share|embed)\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

function extractVimeoId(url: string): string | null {
  const m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  return m ? m[1] : null;
}

export function parseVideoEmbed(url: string): VideoEmbed | null {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  if (/youtube\.com|youtu\.be/.test(trimmed)) {
    const id = extractYouTubeId(trimmed);
    if (id) {
      return {
        provider: "youtube",
        embedSrc: `https://www.youtube.com/embed/${id}`,
        posterSrc: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      };
    }
  }

  if (/loom\.com/.test(trimmed)) {
    const id = extractLoomId(trimmed);
    if (id) {
      return {
        provider: "loom",
        embedSrc: `https://www.loom.com/embed/${id}`,
      };
    }
  }

  if (/vimeo\.com/.test(trimmed)) {
    const id = extractVimeoId(trimmed);
    if (id) {
      return {
        provider: "vimeo",
        embedSrc: `https://player.vimeo.com/video/${id}`,
      };
    }
  }

  // Basic sanity check before treating as raw
  if (!/^https?:\/\//i.test(trimmed)) return null;

  return { provider: "raw", embedSrc: trimmed };
}
