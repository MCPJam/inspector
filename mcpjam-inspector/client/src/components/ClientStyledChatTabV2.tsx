import type { ComponentProps } from "react";
import { ChatTabV2 } from "./ChatTabV2";
import {
  ChatboxHostStyleProvider,
  ChatboxHostThemeProvider,
} from "@/contexts/chatbox-client-style-context";
import { ChatboxHostCapabilitiesOverrideProvider } from "@/contexts/chatbox-client-capabilities-override-context";
import { ActiveMcpProfileProvider } from "@/contexts/active-mcp-profile-context";
import { ActiveHostClientCapabilitiesScope } from "@/contexts/active-host-client-capabilities-context";
import { getChatboxShellStyle } from "@/lib/chatbox-client-style";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
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
    (state) => state.hostCapabilitiesOverride
  );

  const hostStyle = activeHost?.hostStyle ?? prefHostStyle;
  const hostCapabilitiesOverride =
    activeHost?.hostCapabilitiesOverride ?? prefHostCapabilitiesOverride;
  const activeMcpProfile = activeHost?.mcpProfile;
  const shellStyle = getChatboxShellStyle(hostStyle, themeMode);

  return (
    <ChatboxHostStyleProvider value={hostStyle}>
      <ChatboxHostCapabilitiesOverrideProvider value={hostCapabilitiesOverride}>
        <ChatboxHostThemeProvider value={themeMode}>
          <ActiveMcpProfileProvider value={activeMcpProfile}>
            <ActiveHostClientCapabilitiesScope
              activeHost={activeHost}
              hostStyle={hostStyle}
            >
              <div
                className={cn(
                  "chatbox-host-shell app-theme-scope flex h-full min-h-0 flex-1 flex-col overflow-hidden",
                  themeMode === "dark" && "dark"
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
            </ActiveHostClientCapabilitiesScope>
          </ActiveMcpProfileProvider>
        </ChatboxHostThemeProvider>
      </ChatboxHostCapabilitiesOverrideProvider>
    </ChatboxHostStyleProvider>
  );
}
