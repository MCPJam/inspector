import { createContext, useContext, useState, type ReactNode } from "react";
import { Server } from "lucide-react";
import { cn } from "@mcpjam/design-system/cn";
import { pluginIconCandidates } from "@/shared/plugin-icons";
import { usePreferencesStoreWithDefaults } from "@/stores/preferences/preferences-provider";

type IconSource = { url?: string; icons?: readonly unknown[] };
export const PreviewServerIconSource = createContext<IconSource>({});

function favicon(serverUrl?: string) {
  if (!serverUrl || !URL.canParse(serverUrl)) return;
  const url = new URL(serverUrl);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    return;

  // The hosted worker has no favicon route. Inspector bundles its brand mark.
  if (
    url.origin === "https://mcp.mcpjam.com" ||
    url.origin === "https://mcp-staging.mcpjam.com"
  ) {
    return "/mcp_jam.svg";
  }
  return new URL("/favicon.ico", url.origin).href;
}

export function PreviewServerIcon({
  customUrl,
  className,
  fallback,
}: {
  customUrl?: string;
  className: string;
  fallback?: ReactNode;
}) {
  const { url, icons } = useContext(PreviewServerIconSource);
  const theme = usePreferencesStoreWithDefaults((state) => state.themeMode);
  const declared = pluginIconCandidates({
    toolIcons: customUrl?.startsWith("https://")
      ? [{ src: customUrl }]
      : undefined,
    serverIcons: icons,
    theme: theme === "dark" ? "dark" : "light",
  }).map((icon) => icon.src);
  const site = favicon(url);
  const sources =
    site && !declared.includes(site) ? [...declared, site] : declared;
  const key = JSON.stringify(sources);
  const [failure, setFailure] = useState({ key, count: 0 });
  const index = failure.key === key ? failure.count : 0;
  const src = sources[index];
  if (!src)
    return (
      fallback ?? (
        <Server
          aria-hidden="true"
          className={cn("shrink-0 text-muted-foreground", className)}
        />
      )
    );
  return (
    <img
      key={src}
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      className={cn("shrink-0 object-contain", className)}
      onError={() => setFailure({ key, count: index + 1 })}
    />
  );
}
