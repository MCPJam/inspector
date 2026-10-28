import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@mcpjam/design-system/tabs";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./resizable";
import { CollapsedPanelStrip } from "./collapsed-panel-strip";
import { LoggerView } from "../logger-view";
import { useJsonRpcPanelVisibility } from "@/hooks/use-json-rpc-panel";

type PanelView = "sidebar" | "content" | "right";

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

  /** Selection stays caller-owned; the layout owns mobile pane navigation. */
  mobileNavigation?: {
    selectionKey: string;
    selectionPanel?: "sidebar" | "content";
    onBack?: () => void;
    contentLabel?: string;
    rightLabel?: string;
  };

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
  mobileNavigation,
}: ThreePanelLayoutProps) {
  const { isVisible: isJsonRpcPanelVisible, toggle: toggleJsonRpcPanel } =
    useJsonRpcPanelVisibility({ useDesktopPreference: true });
  const isMobile = useIsMobile();
  const [layoutReady, setLayoutReady] = useState(false);
  const [activePane, setActivePane] = useState<PanelView>("sidebar");
  const leftRef = useRef<React.ComponentRef<typeof ResizablePanel>>(null);
  const rightRef = useRef<React.ComponentRef<typeof ResizablePanel>>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** Last pane+selection focus moved to, so a resize never re-fires it. */
  const focusedSelection = useRef<string | null>(null);
  const selectionKey = mobileNavigation?.selectionKey ?? "";
  const selectionPanel = mobileNavigation?.selectionPanel ?? "sidebar";

  useEffect(() => {
    setActivePane("sidebar");
  }, [id, serverName]);

  useEffect(() => {
    const pane = selectionKey ? selectionPanel : "sidebar";
    setActivePane(pane);
    // Focus follows a navigation the caller made, never a mount or a
    // breakpoint crossing. `isMobile` is a dependency because the body reads
    // it, but a resize is not a navigation: without this guard, crossing
    // 768px mid-typing pulls the cursor out of the form the pane is keeping
    // mounted, and a phone loading the page focuses Browse unprompted.
    const selection = `${pane}:${selectionKey}`;
    const firstRun = focusedSelection.current === null;
    const unchanged = focusedSelection.current === selection;
    focusedSelection.current = selection;
    if (firstRun || unchanged || !isMobile) return;
    const frame = requestAnimationFrame(() => {
      (pane === "sidebar" ? sidebarRef : contentRef).current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [selectionKey, selectionPanel, isMobile]);

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
    (isRightVisible ? (hasCustomRight ? 47 : 40) : hasCustomRight ? 72 : 65);

  const leftExpandedSize = useRef(leftSize);
  const rightExpandedSize = useRef(rightSize);

  // Keep the panel instances alive: mobile tabs must not reset forms or streams.
  useEffect(() => {
    if (!layoutReady) return;
    const left = leftRef.current;
    const rail = rightRef.current;
    if (sidebarVisible && left?.isCollapsed())
      left.resize(leftExpandedSize.current);
    else if (!sidebarVisible) left?.collapse();
    if (isRightVisible && rail?.isCollapsed())
      rail.resize(rightExpandedSize.current);
    else if (!isRightVisible) rail?.collapse();
  }, [sidebarVisible, isRightVisible, layoutReady]);

  const panelStyle = (pane: PanelView): CSSProperties | undefined =>
    isMobile
      ? {
          flexGrow: 1,
          flexShrink: 1,
          flexBasis: 0,
          width: "100%",
          display: activePane === pane ? undefined : "none",
        }
      : undefined;
  const changePane = (value: string) => {
    if (value === "sidebar" || value === "content" || value === "right") {
      setActivePane(value);
    }
  };

  return (
    <Tabs
      value={activePane}
      onValueChange={changePane}
      className="h-full min-h-0 gap-0 overflow-hidden"
    >
      <div className="shrink-0 border-b border-border p-2 md:hidden">
        <TabsList aria-label="Panel views">
          <TabsTrigger value="sidebar">Browse</TabsTrigger>
          <TabsTrigger value="content">
            {mobileNavigation?.contentLabel ?? "Results"}
          </TabsTrigger>
          <TabsTrigger value="right">
            {mobileNavigation?.rightLabel ?? "Logs"}
          </TabsTrigger>
        </TabsList>
        {activePane === "content" &&
          selectionKey &&
          mobileNavigation?.onBack && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                mobileNavigation.onBack?.();
                setActivePane("sidebar");
              }}
            >
              <ArrowLeft className="mr-1 h-3 w-3" />
              Back to list
            </Button>
          )}
      </div>
      <ResizablePanelGroup
        direction="horizontal"
        onLayout={() => setLayoutReady(true)}
        className="flex-1 min-h-0 overflow-hidden"
      >
        <ResizablePanel
          key="sidebar"
          ref={leftRef}
          onResize={(size) => {
            if (size > 0) leftExpandedSize.current = size;
          }}
          id={`${id}-left`}
          order={1}
          defaultSize={sidebarVisible ? leftSize : 0}
          minSize={1}
          maxSize={55}
          collapsible
          collapsedSize={0}
          onCollapse={() => {
            if (!isMobile) onSidebarVisibilityChange(false);
          }}
          className="min-h-0 overflow-hidden"
          style={panelStyle("sidebar")}
        >
          <TabsContent
            tabIndex={isMobile ? 0 : -1}
            role={isMobile ? "tabpanel" : undefined}
            ref={sidebarRef}
            inert={!isMobile && !sidebarVisible}
            aria-hidden={(!isMobile && !sidebarVisible) || undefined}
            value="sidebar"
            forceMount
            className="m-0 h-full min-h-0 overflow-hidden"
          >
            {sidebar}
          </TabsContent>
        </ResizablePanel>
        {!isMobile && !sidebarVisible && (
          <CollapsedPanelStrip
            side="left"
            onOpen={() => onSidebarVisibilityChange(true)}
            tooltipText={sidebarTooltip}
          />
        )}
        <ResizableHandle
          withHandle
          disabled={isMobile || !sidebarVisible}
          className={isMobile || !sidebarVisible ? "hidden" : undefined}
        />
        <ResizablePanel
          key="content"
          id={`${id}-center`}
          order={2}
          defaultSize={centerSize}
          minSize={30}
          className="min-h-0 overflow-hidden"
          style={panelStyle("content")}
        >
          <TabsContent
            tabIndex={isMobile ? 0 : -1}
            role={isMobile ? "tabpanel" : undefined}
            ref={contentRef}
            value="content"
            forceMount
            className="m-0 h-full min-h-0 overflow-hidden"
          >
            {content}
          </TabsContent>
        </ResizablePanel>
        <ResizableHandle
          withHandle
          disabled={isMobile || !isRightVisible}
          className={isMobile || !isRightVisible ? "hidden" : undefined}
        />
        <ResizablePanel
          key="right"
          ref={rightRef}
          onResize={(size) => {
            if (size > 0) rightExpandedSize.current = size;
          }}
          id={`${id}-right`}
          order={3}
          defaultSize={isRightVisible ? rightSize : 0}
          minSize={2}
          maxSize={50}
          collapsible
          collapsedSize={0}
          onCollapse={() => {
            if (!isMobile && isRightVisible) collapseRight();
          }}
          className="min-h-0 overflow-hidden"
          style={panelStyle("right")}
        >
          <TabsContent
            tabIndex={isMobile ? 0 : -1}
            role={isMobile ? "tabpanel" : undefined}
            inert={!isMobile && !isRightVisible}
            aria-hidden={(!isMobile && !isRightVisible) || undefined}
            value="right"
            forceMount
            className="m-0 h-full min-h-0 overflow-hidden"
          >
            {hasCustomRight ? (
              right
            ) : (isMobile || isRightVisible) && (
              <LoggerView
                serverIds={serverName ? [serverName] : undefined}
                onClose={
                  isMobile ? () => setActivePane("sidebar") : toggleJsonRpcPanel
                }
              />
            )}
          </TabsContent>
        </ResizablePanel>
        {!isMobile && !isRightVisible && (
          <CollapsedPanelStrip onOpen={openRight} tooltipText={rightTooltip} />
        )}
      </ResizablePanelGroup>
    </Tabs>
  );
}
