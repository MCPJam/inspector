import { useEffect, useMemo } from "react";
import { type AnyView } from "@/hooks/useViews";
import { type ConnectionStatus } from "@/state/app-types";
import { ViewPreview } from "./ViewPreview";
import {
  DisplayContextHeader,
  PRESET_DEVICE_CONFIGS,
} from "@/components/shared/DisplayContextHeader";
import {
  useUIPlaygroundStore,
  type DeviceType,
} from "@/stores/ui-playground-store";
import { UIType } from "@/lib/mcp-ui/mcp-apps-utils";

interface ViewDetailPanelProps {
  view: AnyView;
  serverName?: string;
  /** Server connection status for determining online/offline state */
  serverConnectionStatus?: ConnectionStatus;
  /** Override toolInput from parent for live editing */
  toolInputOverride?: unknown;
  /** Override toolOutput from parent for live editing */
  toolOutputOverride?: unknown;
  /** Override widgetState from parent for live editing (OpenAI views) */
  widgetStateOverride?: unknown;
  /** Override loading state from parent for live editing */
  isLoadingOverride?: boolean;
  /** Override toolOutput error from parent for live editing */
  toolOutputErrorOverride?: string | null;
  /** Whether the view is being edited - controls header visibility */
  isEditing?: boolean;
}

/**
 * ViewDetailPanel - Shows the UI preview for a view with display context controls.
 * The Editor is handled separately in the parent ViewsTab.
 */
export function ViewDetailPanel({
  view,
  serverName,
  serverConnectionStatus,
  toolInputOverride,
  toolOutputOverride,
  widgetStateOverride,
  isLoadingOverride,
  toolOutputErrorOverride,
  isEditing = false,
}: ViewDetailPanelProps) {
  // Store state for device frame
  const storeDeviceType = useUIPlaygroundStore((s) => s.deviceType);
  const customViewport = useUIPlaygroundStore((s) => s.customViewport);

  // Store actions for initializing state
  const setPlaygroundActive = useUIPlaygroundStore(
    (s) => s.setPlaygroundActive,
  );
  const setDeviceType = useUIPlaygroundStore((s) => s.setDeviceType);
  const setCustomViewport = useUIPlaygroundStore((s) => s.setCustomViewport);
  const updateGlobal = useUIPlaygroundStore((s) => s.updateGlobal);
  const setCapabilities = useUIPlaygroundStore((s) => s.setCapabilities);
  const setSafeAreaInsets = useUIPlaygroundStore((s) => s.setSafeAreaInsets);
  const setSelectedProtocol = useUIPlaygroundStore(
    (s) => s.setSelectedProtocol,
  );

  // Compute device config for frame dimensions
  const deviceConfig = useMemo(() => {
    if (storeDeviceType === "custom") {
      return {
        width: customViewport.width,
        height: customViewport.height,
      };
    }
    return PRESET_DEVICE_CONFIGS[storeDeviceType];
  }, [storeDeviceType, customViewport]);

  // Set playground active on mount, reset on unmount
  useEffect(() => {
    setPlaygroundActive(true);
    return () => setPlaygroundActive(false);
  }, [setPlaygroundActive]);

  // Set the selected protocol based on the view
  useEffect(() => {
    const protocol =
      view.protocol === "mcp-apps" ? UIType.MCP_APPS : UIType.OPENAI_SDK;
    setSelectedProtocol(protocol);
  }, [view.protocol, setSelectedProtocol]);

  // Initialize store values from view's defaultContext when view changes
  useEffect(() => {
    if (view.defaultContext) {
      const ctx = view.defaultContext;

      if (ctx.deviceType) {
        setDeviceType(ctx.deviceType as DeviceType);
      }
      if (ctx.viewport) {
        setCustomViewport(ctx.viewport);
      }
      if (ctx.locale) {
        updateGlobal("locale", ctx.locale);
      }
      if (ctx.timeZone) {
        updateGlobal("timeZone", ctx.timeZone);
      }
      if (ctx.capabilities) {
        setCapabilities(ctx.capabilities);
      }
      if (ctx.safeAreaInsets) {
        setSafeAreaInsets(ctx.safeAreaInsets);
      }
    }
  }, [
    view._id,
    view.defaultContext,
    setDeviceType,
    setCustomViewport,
    updateGlobal,
    setCapabilities,
    setSafeAreaInsets,
  ]);

  // Determine protocol for DisplayContextHeader
  const protocol =
    view.protocol === "mcp-apps" ? UIType.MCP_APPS : UIType.OPENAI_SDK;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header with display context controls - only shown in edit mode */}
      {isEditing && (
        <div className="flex items-center justify-center px-4 py-2 border-b bg-muted/30 text-xs text-muted-foreground">
          <DisplayContextHeader protocol={protocol} />
        </div>
      )}

      {/* Preview with device frame */}
      <div className="flex-1 flex items-center justify-center p-4 min-h-0 overflow-auto bg-muted/20">
        <div
          className="relative bg-background border border-border rounded-xl shadow-lg flex flex-col overflow-hidden"
          style={{
            width: deviceConfig.width,
            maxWidth: "100%",
            height: deviceConfig.height,
            maxHeight: "100%",
          }}
        >
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
            <ViewPreview
              view={view}
              displayMode="inline"
              serverName={serverName}
              serverConnectionStatus={serverConnectionStatus}
              toolInputOverride={toolInputOverride}
              toolOutputOverride={toolOutputOverride}
              widgetStateOverride={widgetStateOverride}
              isLoadingOverride={isLoadingOverride}
              toolOutputErrorOverride={toolOutputErrorOverride}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
