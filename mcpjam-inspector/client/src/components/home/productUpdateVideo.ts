export type VideoProvider = "youtube" | "loom" | "vimeo" | "raw";

export interface VideoEmbed {
  provider: VideoProvider;
  embedSrc: string;
  posterSrc?: string;
}

function extractYouTubeId(u: URL): string | null {
  // youtu.be/<id>
  if (u.hostname === "youtu.be") {
    const m = u.pathname.match(/^\/([A-Za-z0-9_-]{6,})/);
    return m ? m[1] : null;
  }
  // youtube.com/watch?v=<id>
  const v = u.searchParams.get("v");
  if (v && /^[A-Za-z0-9_-]{6,}$/.test(v)) return v;
  // youtube.com/shorts/<id> or youtube.com/embed/<id>
  const m = u.pathname.match(/^\/(?:shorts|embed)\/([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : null;
}

function extractLoomId(u: URL): string | null {
  const m = u.pathname.match(/^\/(?:share|embed)\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

function extractVimeoId(u: URL): string | null {
  const m = u.pathname.match(/^\/(?:video\/)?(\d+)/);
  return m ? m[1] : null;
}

export function parseVideoEmbed(url: string): VideoEmbed | null {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  // Hostname checks accept the canonical host and any subdomain (e.g.
  // www.youtube.com, m.youtube.com), but reject lookalikes like
  // evil.com/youtube.com that the previous string-regex matched.
  const host = parsed.hostname.toLowerCase();
  const isHost = (h: string) => host === h || host.endsWith(`.${h}`);

  if (isHost("youtube.com") || host === "youtu.be") {
    const id = extractYouTubeId(parsed);
    if (id) {
      return {
        provider: "youtube",
        embedSrc: `https://www.youtube.com/embed/${id}`,
        posterSrc: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      };
    }
  }

  if (isHost("loom.com")) {
    const id = extractLoomId(parsed);
    if (id) {
      return {
        provider: "loom",
        embedSrc: `https://www.loom.com/embed/${id}`,
      };
    }
  }

  if (isHost("vimeo.com")) {
    const id = extractVimeoId(parsed);
    if (id) {
      return {
        provider: "vimeo",
        embedSrc: `https://player.vimeo.com/video/${id}`,
      };
    }
  }

  return { provider: "raw", embedSrc: parsed.href };
}
