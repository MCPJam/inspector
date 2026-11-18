import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  FeatureSpotlightActions,
  FeatureSpotlightBadge,
  FeatureSpotlightDescription,
  FeatureSpotlightTitle,
} from "@mcpjam/design-system/feature-spotlight";
import { SUITE_COPY } from "@/components/conformance/conformance-ui";
import { AnnouncementSpotlight } from "@/components/announcement-popups";
import { track } from "@/lib/analytics";
import { buildConformanceRunServerPath } from "@/lib/app-navigation";
import { useIsMobile } from "@/hooks/use-mobile";
import { useOptionalSharedAppState } from "@/state/app-state-context";
import type { ServerWithName } from "@/state/app-types";

export const CONFORMANCE_SPOTLIGHT_STORAGE_KEY =
  "mcpjam:conformance-spotlight:status";
/** Lets the sidebar settle first, so the card lands on the row and stays. */
export const CONFORMANCE_SPOTLIGHT_DELAY_MS = 1200;

const SUITE_TITLES = Object.values(SUITE_COPY).map((suite) => suite.title);
const SUITE_LIST = `${SUITE_TITLES.slice(0, -1).join(", ")} and ${SUITE_TITLES.at(-1)}`;

type CloseReason = "primary" | "dismiss" | "visited";

function readDismissed(): boolean {
  try {
    return (
      localStorage.getItem(CONFORMANCE_SPOTLIGHT_STORAGE_KEY) === "dismissed"
    );
  } catch {
    return false;
  }
}

function rememberDismissed(): void {
  try {
    localStorage.setItem(CONFORMANCE_SPOTLIGHT_STORAGE_KEY, "dismissed");
  } catch {
    // Unwritable storage: the card shows again next load, nothing breaks.
  }
}

/**
 * The server the primary action checks: the selected one, else the first
 * connected one, else the first saved one. Null when there are none.
 */
export function pickConformanceServer(
  servers: Record<string, ServerWithName>,
  selectedServer: string | undefined,
): string | null {
  const selected = selectedServer ? servers[selectedServer] : undefined;
  const offered = Object.values(servers);
  return (
    selected?.name ??
    offered.find((server) => server.connectionStatus === "connected")?.name ??
    offered[0]?.name ??
    null
  );
}

/**
 * Introduces Conformance once per browser, pinned to its sidebar row. Any
 * close counts: a CTA, Got it, Escape, an outside click, or opening the page
 * some other way. A reload before any of those shows it again.
 */
export function ConformanceSpotlight({
  enabled,
  servers,
  onConformancePage,
  onNavigate,
  children,
}: {
  /** The Conformance row is visible to this user. */
  enabled: boolean;
  /**
   * The servers the Conformance page offers, saved ones included. Defaults
   * to the runtime connections, which miss saved servers not yet loaded.
   */
  servers?: Record<string, ServerWithName>;
  onConformancePage: boolean;
  onNavigate: (path: string) => void;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  const appState = useOptionalSharedAppState();
  const serverName = pickConformanceServer(
    servers ?? appState?.servers ?? {},
    appState?.selectedServer,
  );
  const [dismissed, setDismissed] = useState(readDismissed);
  const [ready, setReady] = useState(false);
  const shown = useRef(false);
  const eligible = enabled && !dismissed && !isMobile;

  useEffect(() => {
    if (!eligible) return;
    const timer = window.setTimeout(
      () => setReady(true),
      CONFORMANCE_SPOTLIGHT_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [eligible]);

  const close = (reason: CloseReason) => {
    rememberDismissed();
    setDismissed(true);
    track("feature_spotlight_engagement", {
      location: "mcp_sidebar",
      feature: "conformance",
      action: "closed",
      close_reason: reason,
      has_server: serverName !== null,
    });
  };

  useEffect(() => {
    // Reaching the page is what the card asks for, so it has done its job.
    if (eligible && onConformancePage) close("visited");
  });

  const handleShown = () => {
    if (shown.current) return;
    shown.current = true;
    track("feature_spotlight_engagement", {
      location: "mcp_sidebar",
      feature: "conformance",
      action: "shown",
      has_server: serverName !== null,
    });
  };

  if (!eligible) return <>{children}</>;

  return (
    <AnnouncementSpotlight
      eligible={ready && !onConformancePage}
      anchor={children}
      onDismiss={() => close("dismiss")}
      onShown={handleShown}
    >
      <FeatureSpotlightBadge />
      <FeatureSpotlightTitle>
        Check your server against the MCP spec
      </FeatureSpotlightTitle>
      <FeatureSpotlightDescription>
        Conformance runs the spec's {SUITE_LIST} checks on your server and
        explains every failure in plain language. Fix them before Claude or
        ChatGPT users run into them.
      </FeatureSpotlightDescription>
      <FeatureSpotlightActions>
        <Button
          size="sm"
          onClick={() => {
            close("primary");
            onNavigate(
              serverName
                ? buildConformanceRunServerPath(serverName)
                : "/conformance",
            );
          }}
        >
          {serverName ? `Check ${serverName}` : "Open Conformance"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => close("dismiss")}>
          Got it
        </Button>
      </FeatureSpotlightActions>
    </AnnouncementSpotlight>
  );
}
