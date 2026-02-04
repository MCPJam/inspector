import { type AnyView } from "@/hooks/useViews";
import { type ConnectionStatus } from "@/state/app-types";
import { ViewPreview } from "./ViewPreview";

interface ViewDetailPanelProps {
  view: AnyView;
  serverName?: string;
  /** Server connection status for determining online/offline state */
  serverConnectionStatus?: ConnectionStatus;
  /** Override toolInput from parent for live editing */
  toolInputOverride?: unknown;
  /** Override toolOutput from parent for live editing */
  toolOutputOverride?: unknown;
}

/**
 * ViewDetailPanel - Shows just the UI preview for a view.
 * The Editor is handled separately in the parent ViewsTab.
 */
export function ViewDetailPanel({
  view,
  serverName,
  serverConnectionStatus,
  toolInputOverride,
  toolOutputOverride,
}: ViewDetailPanelProps) {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center px-4 py-2 border-b bg-muted/30">
        <span className="text-sm font-medium text-muted-foreground">
          UI
        </span>
      </div>

      {/* Preview */}
      <div className="flex-1 overflow-auto">
        <ViewPreview
          view={view}
          displayMode="inline"
          serverName={serverName}
          serverConnectionStatus={serverConnectionStatus}
          toolInputOverride={toolInputOverride}
          toolOutputOverride={toolOutputOverride}
        />
      </div>
    </div>
  );
}
