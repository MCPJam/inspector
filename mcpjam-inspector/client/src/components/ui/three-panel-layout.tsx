import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./resizable";
import { CollapsedPanelStrip } from "./collapsed-panel-strip";
import { LoggerView } from "../logger-view";
import { useJsonRpcPanelVisibility } from "@/hooks/use-json-rpc-panel";

interface ThreePanelLayoutProps {
  /** Unique ID prefix for panel persistence (e.g., "tools", "prompts") */
  id: string;

  /** Content for the left sidebar panel */
  sidebar: React.ReactNode;

  /** Content for the center panel */
  content: React.ReactNode;

  /** Whether the sidebar is visible */
  sidebarVisible: boolean;

  /** Callback when sidebar visibility changes */
  onSidebarVisibilityChange: (visible: boolean) => void;

  /** Tooltip text for the collapsed sidebar strip */
  sidebarTooltip?: string;

  /** Server name for the LoggerView */
  serverName?: string;

  /**
   * Optional right-rail content. When set, this replaces the JSON-RPC
   * LoggerView and uses `rightVisible` / `onRightVisibilityChange` instead of
   * the global JSON-RPC panel preference.
   */
  right?: React.ReactNode;

  /** Whether a custom right rail is visible. Ignored when `right` is omitted. */
  rightVisible?: boolean;

  /** Callback when a custom right rail is collapsed or reopened. */
  onRightVisibilityChange?: (visible: boolean) => void;

  /** Tooltip for the collapsed custom right-rail strip */
  rightTooltip?: string;

  /** Override default panel sizes (percentages). */
  defaultSizes?: {
    left?: number;
    center?: number;
    right?: number;
  };
}

/**
 * A reusable three-panel layout with:
 * - Left: Collapsible sidebar
 * - Center: Main content area
 * - Right: Collapsible logger (JSON-RPC by default, or a custom rail)
 */
export function ThreePanelLayout({
  id,
  sidebar,
  content,
  sidebarVisible,
  onSidebarVisibilityChange,
  sidebarTooltip,
  serverName,
  right,
  rightVisible,
  onRightVisibilityChange,
  rightTooltip,
  defaultSizes,
}: ThreePanelLayoutProps) {
  const { isVisible: isJsonRpcPanelVisible, toggle: toggleJsonRpcPanel } =
    useJsonRpcPanelVisibility();

  const hasCustomRight = right !== undefined;
  const isRightVisible = hasCustomRight
    ? (rightVisible ?? true)
    : isJsonRpcPanelVisible;
  const collapseRight = () => {
    if (hasCustomRight) {
      onRightVisibilityChange?.(false);
      return;
    }
    toggleJsonRpcPanel();
  };
  const openRight = () => {
    if (hasCustomRight) {
      onRightVisibilityChange?.(true);
      return;
    }
    toggleJsonRpcPanel();
  };

  const leftSize = defaultSizes?.left ?? (hasCustomRight ? 28 : 35);
  const rightSize = defaultSizes?.right ?? (hasCustomRight ? 25 : 30);
  const centerSize =
    defaultSizes?.center ??
    (isRightVisible
      ? hasCustomRight
        ? 47
        : 40
      : hasCustomRight
        ? 72
        : 65);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <ResizablePanelGroup
        direction="horizontal"
        className="flex-1 min-h-0 overflow-hidden"
      >
        {/* Left Panel - Sidebar */}
        {sidebarVisible ? (
          <>
            <ResizablePanel
              id={`${id}-left`}
              order={1}
              defaultSize={leftSize}
              minSize={1}
              maxSize={55}
              collapsible={true}
              collapsedSize={0}
              onCollapse={() => onSidebarVisibilityChange(false)}
              className="min-h-0 overflow-hidden"
            >
              {sidebar}
            </ResizablePanel>
            <ResizableHandle withHandle />
          </>
        ) : (
          <CollapsedPanelStrip
            side="left"
            onOpen={() => onSidebarVisibilityChange(true)}
            tooltipText={sidebarTooltip}
          />
        )}

        {/* Center Panel - Content */}
        <ResizablePanel
          id={`${id}-center`}
          order={2}
          defaultSize={centerSize}
          minSize={30}
          className="min-h-0 overflow-hidden"
        >
          {content}
        </ResizablePanel>

        {/* Right Panel - Logger */}
        {isRightVisible ? (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel
              id={`${id}-right`}
              order={3}
              defaultSize={rightSize}
              minSize={2}
              maxSize={50}
              collapsible={true}
              collapsedSize={0}
              onCollapse={collapseRight}
              className="min-h-0 overflow-hidden"
            >
              <div className="h-full min-h-0 overflow-hidden">
                {hasCustomRight ? (
                  right
                ) : (
                  <LoggerView
                    serverIds={serverName ? [serverName] : undefined}
                    onClose={toggleJsonRpcPanel}
                  />
                )}
              </div>
            </ResizablePanel>
          </>
        ) : (
          <CollapsedPanelStrip
            onOpen={openRight}
            tooltipText={rightTooltip}
          />
        )}
      </ResizablePanelGroup>
    </div>
  );
}
