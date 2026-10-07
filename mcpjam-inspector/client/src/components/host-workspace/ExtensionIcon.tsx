import { useState, type CSSProperties } from "react";
import { pluginIconCandidates } from "@/shared/plugin-icons";
import { AppWindow } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PluginIcons } from "@/lib/plugins/plugin-api-types";
import {
  PluginIconImage,
  pluginIconRefs,
} from "@/components/plugins/plugin-icon-image";

/** An MCP `Icon` (tools/list `icons`, `serverInfo.icons`). */
export interface ExtensionIconSource {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: "light" | "dark";
}

/**
 * Which icon a surface shows (OpenAI's plugin design guidance):
 * - `sidebar` (left-rail rows, right-rail tabs): the entrypoint tool's icons,
 *   then the server icon, then the owning plugin's directory logo (MCPJam's
 *   equivalent of the app logo registered for a hosted App), then a generic
 *   icon.
 * - `composer` (composer chips): the plugin's composer icon, then its
 *   directory logo, then the server icon, then generic.
 * - `directory` (plugin lists): the directory logo, then the server icon,
 *   then generic.
 */
export type ExtensionIconKind = "sidebar" | "composer" | "directory";

export interface ExtensionIconSources {
  toolIcons?: readonly unknown[];
  serverIcons?: readonly unknown[];
  composerIcon?: string;
  logo?: string;
  logoDark?: string;
  /**
   * The imported plugin that owns the server. `sidebar` falls back to its
   * directory logo (`logo` / `logoDark` for the theme) after the server icon.
   */
  pluginIcons?: PluginIcons;
}

const SAFE_SRC = /^(https?:\/\/|data:image\/)/i;

/**
 * Tool icons on a discovery entry. Read defensively: older hosts return
 * entries without them, and the field is untrusted server data.
 */
export function declarationIcons(
  declaration: object | undefined,
): readonly unknown[] | undefined {
  const value = declaration as
    | { toolIcons?: unknown; icons?: unknown }
    | undefined;
  const icons = value?.toolIcons ?? value?.icons;
  return Array.isArray(icons) ? icons : undefined;
}

/** The server's icons as discovery reports them beside an entry. */
export function declarationServerIcons(
  declaration: object | undefined,
): readonly unknown[] | undefined {
  const icons = (declaration as { serverIcons?: unknown } | undefined)
    ?.serverIcons;
  return Array.isArray(icons) ? icons : undefined;
}

/** Untrusted server data: keep only well-formed icons with a safe source. */
export function normalizeIcons(
  icons: readonly unknown[] | undefined,
): ExtensionIconSource[] {
  if (!Array.isArray(icons)) return [];
  return icons.flatMap((icon) => {
    if (!icon || typeof icon !== "object") return [];
    const value = icon as Record<string, unknown>;
    if (
      typeof value.src !== "string" ||
      value.src.length > 1_000_000 ||
      !SAFE_SRC.test(value.src)
    )
      return [];
    return [
      {
        src: value.src,
        ...(typeof value.mimeType === "string"
          ? { mimeType: value.mimeType }
          : {}),
        ...(Array.isArray(value.sizes)
          ? {
              sizes: value.sizes.filter(
                (size): size is string => typeof size === "string",
              ),
            }
          : {}),
        ...(value.theme === "light" || value.theme === "dark"
          ? { theme: value.theme }
          : {}),
      },
    ];
  });
}

function sizeScore(icon: ExtensionIconSource, target: number): number {
  if (!icon.sizes?.length) return 1_000;
  let best = Number.POSITIVE_INFINITY;
  for (const size of icon.sizes) {
    if (size === "any") return 0;
    const match = /^(\d+)x(\d+)$/.exec(size);
    if (!match) continue;
    const edge = Number(match[1]);
    // Prefer the smallest icon at least as big as the target.
    const score = edge >= target ? edge - target : (target - edge) * 4;
    best = Math.min(best, score);
  }
  return Number.isFinite(best) ? best : 1_000;
}

/**
 * Pick by theme (an icon marked for the other theme is a last resort), then
 * by size, rather than always `icons[0]`.
 */
export function pickIcon(
  icons: readonly ExtensionIconSource[],
  theme: "light" | "dark",
  target = 20,
): ExtensionIconSource | undefined {
  const ranked = icons
    .map((icon, index) => ({
      icon,
      index,
      themeRank: icon.theme === theme ? 0 : icon.theme ? 2 : 1,
      size: sizeScore(icon, target),
    }))
    .sort(
      (a, b) =>
        a.themeRank - b.themeRank || a.size - b.size || a.index - b.index,
    );
  return ranked[0]?.icon;
}

export function isSvgIcon(icon: ExtensionIconSource): boolean {
  return (
    icon.mimeType === "image/svg+xml" ||
    /^data:image\/svg\+xml[;,]/i.test(icon.src) ||
    /\.svg(?:[?#].*)?$/i.test(icon.src)
  );
}

/**
 * Every usable icon for a surface, best first. Sidebar icons follow the
 * host's shared ranking (`pluginIconCandidates`: the tool's icons, then the
 * server's, for this theme); the composer and directory chains add the
 * plugin's manifest icons in front of the server's.
 */
export function extensionIconCandidates(
  kind: ExtensionIconKind,
  sources: ExtensionIconSources,
  theme: "light" | "dark",
  target = 20,
): ExtensionIconSource[] {
  if (kind === "sidebar") {
    const shared = pluginIconCandidates({
      toolIcons: sources.toolIcons,
      serverIcons: sources.serverIcons,
      theme,
    }).map((candidate) => ({
      src: candidate.src,
      ...(candidate.svg ? { mimeType: "image/svg+xml" } : {}),
    }));
    if (shared.length) return shared;
  }
  const first = resolveExtensionIcon(kind, sources, theme, target);
  return first ? [first] : [];
}

export function resolveExtensionIcon(
  kind: ExtensionIconKind,
  sources: ExtensionIconSources,
  theme: "light" | "dark",
  target = 20,
): ExtensionIconSource | undefined {
  const tool = normalizeIcons(sources.toolIcons);
  const server = normalizeIcons(sources.serverIcons);
  const logo =
    theme === "dark"
      ? (sources.logoDark ?? sources.logo)
      : (sources.logo ?? sources.logoDark);
  const asIcon = (src: string | undefined) =>
    src && SAFE_SRC.test(src) ? [{ src }] : [];
  const chain: ExtensionIconSource[][] =
    kind === "sidebar"
      ? [tool, server]
      : kind === "composer"
        ? [asIcon(sources.composerIcon), asIcon(logo), server]
        : [asIcon(logo), server];
  for (const candidates of chain) {
    const picked = pickIcon(candidates, theme, target);
    if (picked) return picked;
  }
  return undefined;
}

/**
 * One icon component for extension surfaces. SVG icons render as a CSS mask
 * filled with `currentColor`, so monochrome icons follow light and dark; the
 * server's SVG markup is never inlined (it is untrusted). Other images use
 * an advisory `<img>`. After the MCP icons, a sidebar icon tries the owning
 * plugin's logo; with nothing usable, a generic icon.
 */
export function ExtensionIcon({
  kind,
  sources,
  theme,
  size = 16,
  className,
  label,
}: {
  kind: ExtensionIconKind;
  sources: ExtensionIconSources;
  theme: "light" | "dark";
  size?: number;
  className?: string;
  /** Accessible name; decorative when omitted. */
  label?: string;
}) {
  const candidates = extensionIconCandidates(kind, sources, theme, size);
  const candidateKey = candidates.map((candidate) => candidate.src).join("\n");
  // An image that fails to load falls through to the next candidate, then
  // to the generic icon.
  const [failed, setFailed] = useState<{ key: string; count: number }>({
    key: candidateKey,
    count: 0,
  });
  const skip = failed.key === candidateKey ? failed.count : 0;
  const icon = candidates[skip];
  const next = () => setFailed({ key: candidateKey, count: skip + 1 });
  const box: CSSProperties = { width: size, height: size };
  const a11y = label
    ? { role: "img" as const, "aria-label": label }
    : { "aria-hidden": true as const };
  if (!icon) {
    const generic = (
      <AppWindow
        {...a11y}
        data-extension-icon="generic"
        className={cn("shrink-0", className)}
        style={box}
      />
    );
    const logos =
      kind === "sidebar"
        ? pluginIconRefs(sources.pluginIcons, "directory", theme)
        : [];
    return logos.length ? (
      <PluginIconImage
        refs={logos}
        label={label}
        className={cn("shrink-0 rounded-sm object-contain", className)}
        style={box}
        fallback={generic}
      />
    ) : (
      generic
    );
  }
  if (isSvgIcon(icon)) {
    const url = `url(${JSON.stringify(icon.src)})`;
    return (
      <span
        {...a11y}
        data-extension-icon="mask"
        className={cn("inline-block shrink-0", className)}
        style={{
          ...box,
          backgroundColor: "currentColor",
          maskImage: url,
          WebkitMaskImage: url,
          maskSize: "contain",
          WebkitMaskSize: "contain",
          maskRepeat: "no-repeat",
          WebkitMaskRepeat: "no-repeat",
          maskPosition: "center",
          WebkitMaskPosition: "center",
        }}
      >
        {/* A CSS mask can't report a failed load; this unseen copy can, so
            a broken SVG falls to the next candidate instead of a blank. */}
        <img
          src={icon.src}
          alt=""
          hidden
          referrerPolicy="no-referrer"
          data-extension-icon="probe"
          onError={next}
        />
      </span>
    );
  }
  return (
    <img
      {...(label ? { alt: label } : { alt: "", "aria-hidden": true })}
      data-extension-icon="image"
      src={icon.src}
      className={cn("shrink-0 rounded-sm object-contain", className)}
      style={box}
      draggable={false}
      referrerPolicy="no-referrer"
      onError={next}
    />
  );
}
