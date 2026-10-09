import type { ReactNode } from "react";
import { cn } from "@mcpjam/design-system/cn";
import { ActiveMcpProfileProvider } from "@/contexts/active-mcp-profile-context";
import { ActiveHostCapsResolverScope } from "@/contexts/active-host-client-capabilities-context";
import { ScenarioHostCapabilitiesOverrideProvider } from "@/contexts/scenario-client-capabilities-override-context";
import {
  ScenarioChatUiOverrideProvider,
  ScenarioHostStyleProvider,
  ScenarioHostThemeProvider,
} from "@/contexts/scenario-client-style-context";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import { DEFAULT_HOST_STYLE, type HostThemeMode } from "@/lib/client-styles";
import type { HostSnapshot } from "@/lib/host-snapshot";
import { getScenarioShellStyle } from "@/lib/scenario-client-style";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

/** Host presentation only; the caller owns sizing, borders, and scrolling. */
export function HostStyledShell({
  hostSnapshot,
  activeHost,
  themeMode,
  className,
  children,
}: {
  /** Explicit generic shell. Recorded callers must resolve their config first. */
  hostSnapshot: HostSnapshot | null;
  /** null seeds capabilities from the host style, matching Playground. */
  activeHost: HostConfigDtoV2 | null;
  themeMode?: HostThemeMode | null;
  className?: string;
  children: ReactNode;
}) {
  const preferenceTheme = usePreferencesStore((state) => state.themeMode);
  const effectiveTheme = themeMode ?? preferenceTheme;
  const hostStyle = hostSnapshot?.hostStyle ?? DEFAULT_HOST_STYLE.id;

  return (
    <ActiveMcpProfileProvider value={hostSnapshot?.mcpProfile}>
      <ActiveHostCapsResolverScope
        activeHost={activeHost}
        hostStyle={hostStyle}
      >
        <ScenarioHostStyleProvider value={hostStyle}>
          <ScenarioHostCapabilitiesOverrideProvider
            value={hostSnapshot?.hostCapabilitiesOverride}
          >
            <ScenarioChatUiOverrideProvider
              value={hostSnapshot?.chatUiOverride}
            >
              <ScenarioHostThemeProvider
                value={themeMode === null ? null : effectiveTheme}
              >
                <div
                  className={cn(
                    "scenario-host-shell app-theme-scope",
                    effectiveTheme === "dark" && "dark",
                    className,
                  )}
                  data-host-style={hostStyle}
                  // Match the existing Playground shell's background resolution.
                  style={getScenarioShellStyle(hostStyle, effectiveTheme)}
                >
                  {children}
                </div>
              </ScenarioHostThemeProvider>
            </ScenarioChatUiOverrideProvider>
          </ScenarioHostCapabilitiesOverrideProvider>
        </ScenarioHostStyleProvider>
      </ActiveHostCapsResolverScope>
    </ActiveMcpProfileProvider>
  );
}
