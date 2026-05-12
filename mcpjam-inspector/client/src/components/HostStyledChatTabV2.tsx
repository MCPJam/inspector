import type { ComponentProps } from "react";
import { ChatTabV2 } from "./ChatTabV2";
import {
  ChatboxHostStyleProvider,
  ChatboxHostThemeProvider,
} from "@/contexts/chatbox-host-style-context";
import { ChatboxHostCapabilitiesOverrideProvider } from "@/contexts/chatbox-host-capabilities-override-context";
import { ChatboxMcpProfileProvider } from "@/contexts/chatbox-mcp-profile-context";
import { getChatboxShellStyle } from "@/lib/chatbox-host-style";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

type HostStyledChatTabV2Props = Omit<
  ComponentProps<typeof ChatTabV2>,
  "hostStyle" | "onHostStyleChange"
>;

export function HostStyledChatTabV2({
  showHostStyleSelector = false,
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
        {/* Direct Chat has no profile editor yet — Provider stays
            in the tree so children that read useChatboxMcpProfile
            get a stable `undefined` (= SDK defaults). When a Direct
            Chat profile editor lands, lift the value into the
            preferences store and feed it here. */}
        <ChatboxMcpProfileProvider value={undefined}>
        <ChatboxHostThemeProvider value={themeMode}>
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
        </ChatboxHostThemeProvider>
        </ChatboxMcpProfileProvider>
      </ChatboxHostCapabilitiesOverrideProvider>
    </ChatboxHostStyleProvider>
  );
}
