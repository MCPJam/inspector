import { memo, useMemo } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DiagramLayout, buildNodesAndEdges } from "@/components/oauth/shared";
import { buildXAAActions } from "@/lib/xaa/sequence-actions";
import type { XAAFlowState, XAAFlowStep } from "@/lib/xaa/types";

const XAA_ACTORS = {
  client: { label: "MCP Client", color: "#10b981" },
  testIdp: { label: "MCPJam Issuer", color: "#ef4444" },
  mcpServer: { label: "MCP Server", color: "#f59e0b" },
  authServer: { label: "Authorization Server", color: "#3b82f6" },
};

const XAA_ACTOR_X_POSITIONS = {
  client: 100,
  testIdp: 360,
  mcpServer: 650,
  authServer: 930,
};

interface XAASequenceDiagramProps {
  flowState: XAAFlowState;
  focusedStep?: XAAFlowStep | null;
  hasProfile?: boolean;
  onConfigure?: () => void;
}

const XAADiagramContent = memo(
  ({
    flowState,
    focusedStep,
  }: Pick<XAASequenceDiagramProps, "flowState" | "focusedStep">) => {
    const actions = useMemo(() => buildXAAActions(flowState), [flowState]);
    const { nodes, edges } = useMemo(
      () =>
        buildNodesAndEdges(actions, flowState.currentStep, {
          actors: XAA_ACTORS,
          actorXPositions: XAA_ACTOR_X_POSITIONS,
        }),
      [actions, flowState.currentStep],
    );

    return (
      <DiagramLayout
        nodes={nodes}
        edges={edges}
        currentStep={flowState.currentStep}
        focusedStep={focusedStep}
      />
    );
  },
);

XAADiagramContent.displayName = "XAADiagramContent";

export const XAASequenceDiagram = memo(
  ({
    flowState,
    focusedStep,
    hasProfile = true,
    onConfigure,
  }: XAASequenceDiagramProps) => {
    return (
      <div className="relative h-full w-full">
        <div
          className={
            hasProfile
              ? "h-full w-full"
              : "h-full w-full opacity-30 pointer-events-none"
          }
        >
          <ReactFlowProvider>
            <XAADiagramContent
              flowState={flowState}
              focusedStep={focusedStep}
            />
          </ReactFlowProvider>
        </div>

        {!hasProfile && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="bg-background border border-border rounded-lg shadow-lg p-8 max-w-md text-center">
              <div className="mx-auto w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4">
                <Settings className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-semibold mb-2">
                Configure XAA Target
              </h3>
              <p className="text-sm text-muted-foreground mb-6">
                Add an MCP server URL, client ID, and target authorization
                server to step through the synthetic XAA flow.
              </p>
              {onConfigure && (
                <Button onClick={onConfigure} size="lg">
                  Configure Target
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    );
  },
);

XAASequenceDiagram.displayName = "XAASequenceDiagram";
