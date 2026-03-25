import { useState } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { CollapsedPanelStrip } from "@/components/ui/collapsed-panel-strip";
import { useJsonRpcPanelVisibility } from "@/hooks/use-json-rpc-panel";
import { LearningSandboxLoggerPanel } from "./LearningSandboxLoggerPanel";

interface LearningSandboxShellProps {
  id: string;
  title: string;
  description: string;
  serverId: string;
  sidebar: React.ReactNode;
  children: React.ReactNode;
  serverInfo?: React.ReactNode;
  sidebarTooltip?: string;
}

export function LearningSandboxShell({
  id,
  title,
  description,
  serverId,
  sidebar,
  children,
  serverInfo,
  sidebarTooltip = "Show sandbox explorer",
}: LearningSandboxShellProps) {
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const { isVisible: isLoggerVisible, toggle: toggleLogger } =
    useJsonRpcPanelVisibility();

  return (
    <div className="h-full flex flex-col">
      <ResizablePanelGroup direction="horizontal" className="flex-1">
        {sidebarVisible ? (
          <>
            <ResizablePanel
              id={`${id}-sidebar`}
              order={1}
              defaultSize={28}
              minSize={18}
              maxSize={38}
              collapsible
              collapsedSize={0}
              onCollapse={() => setSidebarVisible(false)}
            >
              {sidebar}
            </ResizablePanel>
            <ResizableHandle withHandle />
          </>
        ) : (
          <CollapsedPanelStrip
            side="left"
            onOpen={() => setSidebarVisible(true)}
            tooltipText={sidebarTooltip}
          />
        )}

        <ResizablePanel
          id={`${id}-content`}
          order={2}
          defaultSize={isLoggerVisible ? 44 : 72}
          minSize={30}
        >
          <div className="h-full min-h-0 overflow-auto bg-background">
            <div className="mx-auto flex h-full max-w-7xl flex-col gap-4 p-4">
              <div className="space-y-1">
                <h2 className="text-lg font-semibold text-foreground">{title}</h2>
                <p className="text-sm text-muted-foreground">{description}</p>
              </div>
              {serverInfo}
              <div className="flex-1 min-h-0">{children}</div>
            </div>
          </div>
        </ResizablePanel>

        {isLoggerVisible ? (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel
              id={`${id}-logger`}
              order={3}
              defaultSize={28}
              minSize={18}
              maxSize={42}
              collapsible
              collapsedSize={0}
              onCollapse={toggleLogger}
              className="min-h-0 overflow-hidden"
            >
              <LearningSandboxLoggerPanel
                serverId={serverId}
                onClose={toggleLogger}
              />
            </ResizablePanel>
          </>
        ) : (
          <CollapsedPanelStrip onOpen={toggleLogger} />
        )}
      </ResizablePanelGroup>
    </div>
  );
}
