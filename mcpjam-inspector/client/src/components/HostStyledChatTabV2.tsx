import type { ComponentProps } from "react";
import { ChatTabV2 } from "./ChatTabV2";
import {
  SandboxHostStyleProvider,
  SandboxHostThemeProvider,
} from "@/contexts/sandbox-host-style-context";
import { getSandboxShellStyle } from "@/lib/sandbox-host-style";
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
  const shellStyle = getSandboxShellStyle(hostStyle, themeMode);

  return (
    <SandboxHostStyleProvider value={hostStyle}>
      <SandboxHostThemeProvider value={themeMode}>
        <div
          className={cn(
            "sandbox-host-shell app-theme-scope flex h-full min-h-0 flex-1 flex-col overflow-hidden",
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
      </SandboxHostThemeProvider>
    </SandboxHostStyleProvider>
  );
}
