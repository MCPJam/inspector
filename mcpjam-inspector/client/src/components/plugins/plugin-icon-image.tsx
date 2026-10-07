import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type {
  PluginIconRef,
  PluginIcons,
} from "@/lib/plugins/plugin-api-types";

const SVG_TYPE = "image/svg+xml";
/** Icons are small; refuse anything that clearly isn't one. */
const MAX_SVG_ICON_BYTES = 256 * 1024;

/**
 * Which of a plugin's manifest icons a surface uses (OpenAI's plugin design
 * guidance):
 * - `directory` (plugin lists, and an entrypoint whose tool and server
 *   declare no icon): `logo` / `logoDark`.
 * - `composer` (chips naming the plugin): `composerIcon`, then the
 *   directory icon.
 */
export type PluginIconKind = "directory" | "composer";

/**
 * Every usable manifest icon for a surface, best first: the theme's variant
 * before the other one, so a failed image still has somewhere to fall.
 */
export function pluginIconRefs(
  icons: PluginIcons | undefined,
  kind: PluginIconKind,
  theme: "light" | "dark",
): PluginIconRef[] {
  if (!icons) return [];
  const directory =
    theme === "dark"
      ? [icons.logoDark, icons.logo]
      : [icons.logo, icons.logoDark];
  const ordered =
    kind === "composer" ? [icons.composerIcon, ...directory] : directory;
  const seen = new Set<string>();
  return ordered.filter((ref): ref is PluginIconRef => {
    if (!ref || seen.has(ref.url)) return false;
    seen.add(ref.url);
    return true;
  });
}

/**
 * The `src` for one icon. SVG arrives as a download, so it is fetched and
 * re-typed into a blob URL; in `<img>` an SVG can't run script, and its
 * markup is never inlined into the page. `failed` when the SVG can't be read.
 */
function usePluginIconSrc(ref: PluginIconRef | undefined): {
  src: string | null;
  failed: boolean;
} {
  const url = ref?.url;
  const isSvg = ref?.contentType === SVG_TYPE;
  const [svg, setSvg] = useState<{
    url: string;
    src: string | null;
    failed: boolean;
  } | null>(null);
  useEffect(() => {
    if (!isSvg || !url) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setSvg({ url, src: null, failed: false });
    void (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error("Icon unavailable");
        const bytes = await response.arrayBuffer();
        if (cancelled) return;
        if (bytes.byteLength > MAX_SVG_ICON_BYTES)
          throw new Error("Icon too large");
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: SVG_TYPE }));
        setSvg({ url, src: objectUrl, failed: false });
      } catch {
        if (!cancelled) setSvg({ url, src: null, failed: true });
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [isSvg, url]);
  if (!url) return { src: null, failed: false };
  if (!isSvg) return { src: url, failed: false };
  return svg?.url === url
    ? { src: svg.src, failed: svg.failed }
    : { src: null, failed: false };
}

/**
 * A plugin's manifest icon as an advisory `<img>`. A candidate that fails
 * (an image error, or an SVG that can't be read) falls to the next one, and
 * `fallback` shows while one loads and once none is left.
 */
export function PluginIconImage({
  refs,
  className,
  style,
  label,
  fallback,
}: {
  refs: readonly PluginIconRef[];
  className?: string;
  style?: CSSProperties;
  /** Accessible name; decorative when omitted. */
  label?: string;
  fallback: ReactNode;
}) {
  const key = refs.map((ref) => ref.url).join("\n");
  const [failed, setFailed] = useState({ key, count: 0 });
  const skip = failed.key === key ? failed.count : 0;
  const ref = refs[skip];
  const { src, failed: unreadable } = usePluginIconSrc(ref);
  useEffect(() => {
    if (unreadable) setFailed({ key, count: skip + 1 });
  }, [unreadable, key, skip]);
  if (!ref || !src) return <>{fallback}</>;
  return (
    <img
      src={src}
      {...(label ? { alt: label } : { alt: "", "aria-hidden": true })}
      draggable={false}
      referrerPolicy="no-referrer"
      className={className}
      style={style}
      data-testid="plugin-icon"
      onError={() => setFailed({ key, count: skip + 1 })}
    />
  );
}
