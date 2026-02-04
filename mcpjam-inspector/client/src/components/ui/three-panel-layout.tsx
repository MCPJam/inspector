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
}

/**
 * A reusable three-panel layout with:
 * - Left: Collapsible sidebar
 * - Center: Main content area
 * - Right: Collapsible JSON-RPC logger panel
 */
export function ThreePanelLayout({
  id,
  sidebar,
  content,
  sidebarVisible,
  onSidebarVisibilityChange,
  sidebarTooltip,
  serverName,
}: ThreePanelLayoutProps) {
  const { isVisible: isJsonRpcPanelVisible, toggle: toggleJsonRpcPanel } =
    useJsonRpcPanelVisibility();

  return (
    <div className="h-full flex flex-col">
      <ResizablePanelGroup direction="horizontal" className="flex-1">
        {/* Left Panel - Sidebar */}
        {sidebarVisible ? (
          <>
            <ResizablePanel
              id={`${id}-left`}
              order={1}
              defaultSize={35}
              minSize={1}
              maxSize={55}
              collapsible={true}
              collapsedSize={0}
              onCollapse={() => onSidebarVisibilityChange(false)}
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
          defaultSize={isJsonRpcPanelVisible ? 40 : 65}
          minSize={30}
        >
          {content}
        </ResizablePanel>

        {/* Right Panel - Logger */}
        {isJsonRpcPanelVisible ? (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel
              id={`${id}-right`}
              order={3}
              defaultSize={30}
              minSize={2}
              maxSize={50}
              collapsible={true}
              collapsedSize={0}
              onCollapse={toggleJsonRpcPanel}
              className="min-h-0 overflow-hidden"
            >
              <div className="h-full min-h-0 overflow-hidden">
                <LoggerView
                  serverIds={serverName ? [serverName] : undefined}
                  onClose={toggleJsonRpcPanel}
                />
              </div>
            </ResizablePanel>
          </>
        ) : (
          <CollapsedPanelStrip onOpen={toggleJsonRpcPanel} />
        )}
      </ResizablePanelGroup>
    </div>
  );
}
