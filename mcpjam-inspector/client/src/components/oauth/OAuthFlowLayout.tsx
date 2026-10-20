import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@mcpjam/design-system/tabs";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../ui/resizable";

export function OAuthFlowLayout({
  diagram,
  logger,
  view,
  onViewChange,
}: {
  diagram: ReactNode;
  logger: ReactNode;
  view: string;
  onViewChange: (view: string) => void;
}) {
  const isMobile = useIsMobile();
  const diagramTab = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (isMobile && view === "diagram") diagramTab.current?.focus();
  }, [isMobile, view]);
  const style = (pane: string): CSSProperties | undefined =>
    isMobile
      ? {
          flexGrow: 1,
          flexShrink: 1,
          flexBasis: 0,
          width: "100%",
          display: view === pane ? undefined : "none",
        }
      : undefined;

  return (
    <Tabs
      value={view}
      onValueChange={onViewChange}
      className="h-full min-h-0 gap-0 overflow-hidden"
    >
      <div className="shrink-0 border-b border-border p-2 md:hidden">
        <TabsList aria-label="OAuth views">
          <TabsTrigger value="guide">Guide</TabsTrigger>
          <TabsTrigger ref={diagramTab} value="diagram">
            Diagram
          </TabsTrigger>
        </TabsList>
      </div>
      <ResizablePanelGroup direction="horizontal" className="flex-1 min-h-0">
        <ResizablePanel defaultSize={50} minSize={30} style={style("diagram")}>
          <TabsContent
            forceMount
            value="diagram"
            className="m-0 h-full min-h-0"
          >
            {diagram}
          </TabsContent>
        </ResizablePanel>
        <ResizableHandle
          withHandle
          disabled={isMobile}
          className={isMobile ? "hidden" : undefined}
        />
        <ResizablePanel
          defaultSize={50}
          minSize={20}
          maxSize={50}
          style={style("guide")}
        >
          <TabsContent forceMount value="guide" className="m-0 h-full min-h-0">
            {logger}
          </TabsContent>
        </ResizablePanel>
      </ResizablePanelGroup>
    </Tabs>
  );
}
