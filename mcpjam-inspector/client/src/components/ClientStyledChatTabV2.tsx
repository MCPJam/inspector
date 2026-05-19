import { useMemo, type ComponentProps } from "react";
import { ChatTabV2 } from "./ChatTabV2";
import {
  ChatboxHostStyleProvider,
  ChatboxHostThemeProvider,
} from "@/contexts/chatbox-client-style-context";
import { ChatboxHostCapabilitiesOverrideProvider } from "@/contexts/chatbox-client-capabilities-override-context";
import { ActiveMcpProfileProvider } from "@/contexts/active-mcp-profile-context";
import { ActiveHostClientCapabilitiesProvider } from "@/contexts/active-host-client-capabilities-context";
import { getChatboxShellStyle } from "@/lib/chatbox-client-style";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import {
  seedFromHostTemplate,
  type HostTemplateId,
} from "@/lib/client-templates";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

type HostStyledChatTabV2Props = Omit<
  ComponentProps<typeof ChatTabV2>,
  "hostStyle" | "onHostStyleChange"
> & {
  /**
   * Currently active host — top-bar selection resolved to the project
   * default when no explicit pick exists. Drives every widget-runtime
   * value below; preferences store is the fallback editing surface for
   * the bootstrap window before the host hydrates.
   */
  activeHost?: HostConfigDtoV2;
};

export function ClientStyledChatTabV2({
  showHostStyleSelector = false,
  activeHost,
  ...props
}: HostStyledChatTabV2Props) {
  const themeMode = usePreferencesStore((state) => state.themeMode);
  const prefHostStyle = usePreferencesStore((state) => state.hostStyle);
  const setHostStyle = usePreferencesStore((state) => state.setHostStyle);
  const prefHostCapabilitiesOverride = usePreferencesStore(
    (state) => state.hostCapabilitiesOverride,
  );

  const hostStyle = activeHost?.hostStyle ?? prefHostStyle;
  const hostCapabilitiesOverride =
    activeHost?.hostCapabilitiesOverride ?? prefHostCapabilitiesOverride;
  const activeMcpProfile = activeHost?.mcpProfile;
  // clientCapabilities: prefer the persisted host config; fall back to the
  // template seed for `hostStyle` so prefs-only surfaces (no Convex
  // `activeHost` hydrated) still gate widget rendering correctly. Without
  // this fallback, picking Codex via the host-style preference would still
  // leave `clientCapabilities` undefined here, the gate in PartSwitch would
  // read the legacy-preservation default (`undefined` → allow), and the
  // widget would render even though Codex strips the MCP UI extension.
  const activeHostClientCapabilities = useMemo(() => {
    if (activeHost?.clientCapabilities) return activeHost.clientCapabilities;
    return seedFromHostTemplate(hostStyle as HostTemplateId).clientCapabilities;
  }, [activeHost?.clientCapabilities, hostStyle]);
  const shellStyle = getChatboxShellStyle(hostStyle, themeMode);

  return (
    <ChatboxHostStyleProvider value={hostStyle}>
      <ChatboxHostCapabilitiesOverrideProvider
        value={hostCapabilitiesOverride}
      >
        <ChatboxHostThemeProvider value={themeMode}>
          <ActiveMcpProfileProvider value={activeMcpProfile}>
            <ActiveHostClientCapabilitiesProvider
              value={activeHostClientCapabilities}
            >
              <div
                className={cn(
                  "chatbox-host-shell app-theme-scope flex h-full min-h-0 flex-1 flex-col overflow-hidden",
                  themeMode === "dark" && "dark",
                )}
                data-host-style={hostStyle}
                style={shellStyle}
              >
                <ChatTabV2
                  {...props}
                  // The selector writes only to the preferences store, but
                  // when `activeHost` is present `hostStyle` is derived from
                  // it instead — the control would silently no-op. Suppress
                  // the selector in that case so the user isn't handed a
                  // dead toggle. Surfaces with no active host (e.g. plain
                  // direct chat) still get the prefs-backed picker.
                  showHostStyleSelector={showHostStyleSelector && !activeHost}
                  hostStyle={hostStyle}
                  onHostStyleChange={setHostStyle}
                />
              </div>
            </ActiveHostClientCapabilitiesProvider>
          </ActiveMcpProfileProvider>
        </ChatboxHostThemeProvider>
      </ChatboxHostCapabilitiesOverrideProvider>
    </ChatboxHostStyleProvider>
  );
}
