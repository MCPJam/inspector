import type { ComponentProps } from "react";
import { ChatTabV2 } from "./ChatTabV2";
import { HostStyledShell } from "@/components/chat-v2/host-styled-shell";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
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

  return (
    <HostStyledShell
      hostSnapshot={{
        hostStyle,
        hostCapabilitiesOverride,
        // This caller has never applied activeHost.chatUiOverride.
        chatUiOverride: undefined,
        mcpProfile: activeMcpProfile,
      }}
      activeHost={activeHost ?? null}
      themeMode={themeMode}
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
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
    </HostStyledShell>
  );
}
