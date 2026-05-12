import type { ComponentProps } from "react";
import { ChatTabV2 } from "./ChatTabV2";
import {
  ChatboxHostStyleProvider,
  ChatboxHostThemeProvider,
} from "@/contexts/chatbox-host-style-context";
import { ChatboxHostCapabilitiesOverrideProvider } from "@/contexts/chatbox-host-capabilities-override-context";
import { ActiveMcpProfileProvider } from "@/contexts/active-mcp-profile-context";
import { getChatboxShellStyle } from "@/lib/chatbox-host-style";
import type { HostConfigMcpProfileV1 } from "@/lib/host-config-v2";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

type HostStyledChatTabV2Props = Omit<
  ComponentProps<typeof ChatTabV2>,
  "hostStyle" | "onHostStyleChange"
> & {
  /**
   * Active project default `mcpProfile` envelope. Forwarded into
   * `ActiveMcpProfileProvider` so `MCPAppsRenderer` (mounted deep in
   * `ChatTabV2`'s thread) can read sandbox policy + clientInfo /
   * supportedProtocolVersions pins. The hosted-chat path uses its own
   * provider in `ChatboxChatPage`; this is the in-inspector counterpart.
   * Undefined means "no opt-in" — the renderer falls back to widget-
   * derived sandbox behavior, byte-identical to historical.
   */
  activeMcpProfile?: HostConfigMcpProfileV1;
};

export function HostStyledChatTabV2({
  showHostStyleSelector = false,
  activeMcpProfile,
  ...props
}: HostStyledChatTabV2Props) {
  const themeMode = usePreferencesStore((state) => state.themeMode);
  const hostStyle = usePreferencesStore((state) => state.hostStyle);
  const setHostStyle = usePreferencesStore((state) => state.setHostStyle);
  const hostCapabilitiesOverride = usePreferencesStore(
    (state) => state.hostCapabilitiesOverride,
  );
  const shellStyle = getChatboxShellStyle(hostStyle, themeMode);

  return (
    <ChatboxHostStyleProvider value={hostStyle}>
      <ChatboxHostCapabilitiesOverrideProvider
        value={hostCapabilitiesOverride}
      >
        <ChatboxHostThemeProvider value={themeMode}>
          <ActiveMcpProfileProvider value={activeMcpProfile}>
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
                showHostStyleSelector={showHostStyleSelector}
                hostStyle={hostStyle}
                onHostStyleChange={setHostStyle}
              />
            </div>
          </ActiveMcpProfileProvider>
        </ChatboxHostThemeProvider>
      </ChatboxHostCapabilitiesOverrideProvider>
    </ChatboxHostStyleProvider>
  );
}
