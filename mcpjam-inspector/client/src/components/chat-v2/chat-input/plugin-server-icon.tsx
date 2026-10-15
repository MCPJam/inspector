import { useState } from "react";
import { Blocks } from "lucide-react";
import { cn } from "@/lib/utils";
import { pluginIconCandidates } from "@/shared/plugin-icons";
import { useOptionalSharedAppState } from "@/state/app-state-context";
import type { PluginIcons } from "@/lib/plugins/plugin-api-types";
import {
  PluginIconImage,
  pluginIconRefs,
} from "@/components/plugins/plugin-icon-image";

/**
 * The app theme is the root `.dark` class; reading it keeps this leaf free
 * of store providers so any composer surface can render it.
 */
function documentTheme(): "light" | "dark" {
  return typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
}

/**
 * A plugin/server mark for composer surfaces (mention rows and pills, form
 * cards, context chips), in OpenAI's composer order: an imported plugin's
 * `composerIcon`, then its logo (`logo` / `logoDark`), then the server's own
 * icons, then a generic mark. A failed image falls to the next candidate.
 * Advisory images only: never inline markup.
 */
export function PluginServerIcon({
  serverName,
  icons,
  serverIcons,
  pluginIcons,
  className,
}: {
  serverName?: string;
  /** Explicit MCP icons win over the server's icons. */
  icons?: unknown;
  /**
   * The server's icons as discovery reported them (`server/discover`, else
   * `initialize`). Without them, the connected server's `initialize` icons.
   */
  serverIcons?: readonly unknown[];
  /** The imported plugin's icons, when the server belongs to one. */
  pluginIcons?: PluginIcons;
  className?: string;
}) {
  const theme = documentTheme();
  const fallback = (
    <ServerIcon
      serverName={serverName}
      icons={icons}
      serverIcons={serverIcons}
      theme={theme}
      className={className}
    />
  );
  const refs = pluginIconRefs(pluginIcons, "composer", theme);
  return refs.length ? (
    <PluginIconImage
      refs={refs}
      className={cn("size-4 shrink-0 rounded-sm object-contain", className)}
      fallback={fallback}
    />
  ) : (
    fallback
  );
}

function ServerIcon({
  serverName,
  icons,
  serverIcons,
  theme,
  className,
}: {
  serverName?: string;
  icons?: unknown;
  serverIcons?: readonly unknown[];
  theme: "light" | "dark";
  className?: string;
}) {
  const appState = useOptionalSharedAppState();
  const initialized = serverName
    ? appState?.servers?.[serverName]?.initializationInfo?.serverVersion?.icons
    : undefined;
  const candidates = pluginIconCandidates({
    toolIcons: icons,
    serverIcons: serverIcons?.length ? serverIcons : initialized,
    theme,
  });
  const key = candidates.map((candidate) => candidate.src).join("\n");
  const [failed, setFailed] = useState({ key, count: 0 });
  const skip = failed.key === key ? failed.count : 0;
  const src = candidates[skip]?.src;
  return src ? (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      className={cn("size-4 shrink-0 rounded-sm object-contain", className)}
      referrerPolicy="no-referrer"
      onError={() => setFailed({ key, count: skip + 1 })}
    />
  ) : (
    <Blocks
      aria-hidden="true"
      className={cn("size-4 shrink-0 text-muted-foreground", className)}
    />
  );
}
