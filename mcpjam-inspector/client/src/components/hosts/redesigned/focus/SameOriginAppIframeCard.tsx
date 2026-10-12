import { useEffect, useState } from "react";
import { Switch } from "@mcpjam/design-system/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import {
  isMcpProfileEmpty,
  type HostConfigInputV2,
  type HostConfigMcpProfileV1,
} from "@/lib/client-config-v2";

/**
 * Probe finding: whether the app iframe shares the sandbox page's origin.
 * Off mounts apps in an opaque origin. Like browser
 * storage, a browser consequence of the sandbox rather than an MCP feature.
 */
export function SameOriginAppIframeCard({
  draft,
  onDraftChange,
}: {
  draft: HostConfigInputV2;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2,
  ) => void;
}) {
  const stored = draft.mcpProfile?.apps?.sandbox?.sameOriginAppIframe;
  const sameOrigin = stored !== false;
  // An explicit `true` is a measurement (ChatGPT's template carries one). Once
  // switched off, the draft only holds `false`, so remember the `true` to put
  // it back when the switch goes on again. The tab is keyed by client, so this
  // never carries over to another one.
  const [measuredTrue, setMeasuredTrue] = useState(stored === true);
  useEffect(() => {
    if (stored === true) setMeasuredTrue(true);
  }, [stored]);
  const setSameOrigin = (enabled: boolean) => {
    onDraftChange((prev) => {
      const base: HostConfigMcpProfileV1 = prev.mcpProfile ?? {
        profileVersion: 1,
      };
      const apps = base.apps ?? {};
      const sandbox = { ...(apps.sandbox ?? {}) };
      // Absence means same-origin, so only persist the non-default finding,
      // unless the client had recorded an explicit `true`.
      if (!enabled) sandbox.sameOriginAppIframe = false;
      else if (sandbox.sameOriginAppIframe === true || measuredTrue) {
        sandbox.sameOriginAppIframe = true;
      } else delete sandbox.sameOriginAppIframe;
      const nextApps = { ...apps };
      if (Object.keys(sandbox).length > 0) nextApps.sandbox = sandbox;
      else delete nextApps.sandbox;
      const updated: HostConfigMcpProfileV1 = {
        ...base,
        apps: Object.keys(nextApps).length > 0 ? nextApps : undefined,
      };
      // Collapse to absence, like BrowserStorageCard: flipping the switch off
      // and on again must not mint a new config row.
      return {
        ...prev,
        mcpProfile: isMcpProfileEmpty(updated) ? undefined : updated,
      };
    });
  };

  const toggle = (
    <Switch
      checked={sameOrigin}
      onCheckedChange={setSameOrigin}
      aria-label="Same-origin app iframe"
    />
  );

  return (
    <section
      data-testid="same-origin-app-iframe-card"
      className="rounded-[10px] border border-border bg-background"
    >
      <div className="border-b border-border px-3.5 py-2.5">
        <div className="text-[12px] font-medium">Same-origin app iframe</div>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          When off, your app runs with no origin: storage throws and fetches
          send <code>Origin: null</code>.
        </p>
      </div>
      <div className="flex items-center justify-between gap-3 px-3.5 py-2">
        <span className="font-mono text-[12px]">allow-same-origin</span>
        {stored === undefined ? (
          // Unset is "never probed", not a measured yes; the switch shows
          // the default the app gets.
          <Tooltip>
            <TooltipTrigger asChild>{toggle}</TooltipTrigger>
            <TooltipContent
              variant="muted"
              side="top"
              sideOffset={4}
              className="max-w-[260px] leading-snug"
            >
              Not yet tested on this client. On by default.
            </TooltipContent>
          </Tooltip>
        ) : (
          toggle
        )}
      </div>
    </section>
  );
}
