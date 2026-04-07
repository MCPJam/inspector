import type { ReactNode } from "react";
import { ArrowLeft, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";

interface WalkthroughShellProps {
  title: string;
  badge: string;
  onBack: () => void;
  onComplete?: () => void;
  continueLabel: string;
  onContinue: () => void;
  onReset: () => void;
  guidePanel: ReactNode;
  diagramPanel: ReactNode;
  defaultGuideSize?: number;
}

export function WalkthroughShell({
  title,
  badge,
  onBack,
  onComplete,
  continueLabel,
  onContinue,
  onReset,
  guidePanel,
  diagramPanel,
  defaultGuideSize = 50,
}: WalkthroughShellProps) {
  const isLastStep = continueLabel === "Start over";
  return (
    <div className="flex h-full flex-col">
      {/* Header bar */}
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
            title="Back to Learning"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <h2 className="text-sm font-semibold">{title}</h2>
          <Badge
            variant="secondary"
            className="text-[10px] h-4 px-1.5 shrink-0"
          >
            {badge}
          </Badge>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onReset}
            className="h-7"
            title="Jump back to the first step"
          >
            <RotateCcw className="mr-1 h-3 w-3" />
            Reset
          </Button>
          <Button
            size="sm"
            onClick={() => {
              if (isLastStep && onComplete) onComplete();
              onContinue();
            }}
            className="h-7"
          >
            {continueLabel}
          </Button>
        </div>
      </div>

      {/* Split view: Guide (left) + Diagram (right) */}
      <div className="flex-1 min-h-0">
        <ResizablePanelGroup direction="horizontal" className="h-full">
          <ResizablePanel defaultSize={defaultGuideSize} minSize={30}>
            {guidePanel}
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel
            defaultSize={100 - defaultGuideSize}
            minSize={20}
            maxSize={70}
          >
            {diagramPanel}
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
