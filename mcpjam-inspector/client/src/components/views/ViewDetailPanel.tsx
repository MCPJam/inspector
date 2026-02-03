import {
  type AnyView,
  type DisplayContext,
} from "@/hooks/useViews";
import { type ConnectionStatus } from "@/state/app-types";
import { ViewPreview } from "./ViewPreview";

export interface ViewDraft {
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  toolInput: unknown;
  toolOutput: unknown | null;
  prefersBorder?: boolean;
  defaultContext?: DisplayContext;
}

interface ViewDetailPanelProps {
  view: AnyView;
  draft?: ViewDraft | null;
  isEditing?: boolean;
  hasUnsavedChanges?: boolean;
  onStartEditing?: () => void;
  onSaveChanges?: () => Promise<void>;
  onDiscardChanges?: () => void;
  onDraftChange?: (updates: Partial<ViewDraft>) => void;
  serverName?: string;
  /** Server connection status for determining online/offline state */
  serverConnectionStatus?: ConnectionStatus;
  /** Callback when view is refreshed (re-run tool) */
  onViewRefreshed?: () => void;
}

/**
 * ViewDetailPanel - Shows just the UI preview for a view.
 * The Editor is handled separately in the parent ViewsTab.
 */
export function ViewDetailPanel({
  view,
  serverName,
  serverConnectionStatus,
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
        />
      </div>
    </div>
  );
}
