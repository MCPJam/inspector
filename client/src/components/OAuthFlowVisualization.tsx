import { useMemo, memo } from "react";
import {
  Background,
  Controls,
  Node,
  Edge,
  ReactFlow,
  Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { OauthFlowStateNovember2025, OAuthFlowStep } from "@/lib/debug-oauth-state-machine";

interface OAuthFlowVisualizationProps {
  flowState: OauthFlowStateNovember2025;
}

type NodeStatus = "complete" | "current" | "pending";

interface FlowNodeData {
  label: string;
  description: string;
  status: NodeStatus;
  details?: Array<{ label: string; value: string }>;
}

// Custom node component
const StepNode = memo(({ data }: { data: FlowNodeData }) => {
  const statusColors = {
    complete: "border-green-500 bg-green-50 dark:bg-green-950",
    current: "border-blue-500 bg-blue-50 dark:bg-blue-950 shadow-lg shadow-blue-500/20",
    pending: "border-gray-300 bg-gray-50 dark:bg-gray-900",
  };

  const statusTextColors = {
    complete: "text-green-700 dark:text-green-300",
    current: "text-blue-700 dark:text-blue-300",
    pending: "text-gray-500 dark:text-gray-400",
  };

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 min-w-[250px] ${statusColors[data.status]}`}
    >
      <div className="font-semibold text-sm mb-1">{data.label}</div>
      <div className={`text-xs ${statusTextColors[data.status]}`}>
        {data.description}
      </div>
      {data.details && data.details.length > 0 && (
        <div className="mt-2 space-y-1">
          {data.details.map((detail, idx) => (
            <div key={idx} className="text-xs">
              <span className="font-medium">{detail.label}:</span>{" "}
              <span className="font-mono">{detail.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

StepNode.displayName = "StepNode";

const nodeTypes = {
  stepNode: StepNode,
};

// Helper to determine node status based on current step
const getNodeStatus = (
  nodeStep: OAuthFlowStep,
  currentStep: OAuthFlowStep
): NodeStatus => {
  const stepOrder: OAuthFlowStep[] = [
    "idle",
    "sent_unauthenticated_request",
    "received_401_www_authenticate",
  ];

  const nodeIndex = stepOrder.indexOf(nodeStep);
  const currentIndex = stepOrder.indexOf(currentStep);

  if (nodeIndex < currentIndex) return "complete";
  if (nodeIndex === currentIndex) return "current";
  return "pending";
};

export const OAuthFlowVisualization = memo(
  ({ flowState }: OAuthFlowVisualizationProps) => {
    const { nodes, edges } = useMemo(() => {
      const currentStep = flowState.currentStep;

      const nodeData: Array<{
        id: OAuthFlowStep;
        label: string;
        description: string;
        details?: Array<{ label: string; value: string }>;
      }> = [
        {
          id: "idle",
          label: "1. Idle",
          description: "Ready to begin OAuth flow",
          details: [],
        },
        {
          id: "sent_unauthenticated_request",
          label: "2. Unauthenticated Request",
          description: "Client sends request without credentials",
          details: flowState.serverUrl
            ? [{ label: "Server", value: flowState.serverUrl }]
            : undefined,
        },
        {
          id: "received_401_www_authenticate",
          label: "3. Received 401 Response",
          description: "Server responds with WWW-Authenticate",
          details: flowState.authorizationServer
            ? [
                { label: "Auth Server", value: flowState.authorizationServer },
              ]
            : undefined,
        },
      ];

      const nodes: Node[] = nodeData.map((node, index) => ({
        id: node.id,
        type: "stepNode",
        position: { x: 50, y: index * 150 },
        data: {
          label: node.label,
          description: node.description,
          status: getNodeStatus(node.id, currentStep),
          details: node.details,
        },
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
      }));

      const edges: Edge[] = [];
      for (let i = 0; i < nodeData.length - 1; i++) {
        edges.push({
          id: `edge-${i}`,
          source: nodeData[i].id,
          target: nodeData[i + 1].id,
          type: "smoothstep",
          animated: getNodeStatus(nodeData[i].id, currentStep) === "complete",
          style: {
            stroke:
              getNodeStatus(nodeData[i].id, currentStep) === "complete"
                ? "#10b981"
                : "#d1d5db",
            strokeWidth: 2,
          },
        });
      }

      return { nodes, edges };
    }, [flowState]);

    return (
      <div className="w-full h-full">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.5}
          maxZoom={1.5}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    );
  }
);

OAuthFlowVisualization.displayName = "OAuthFlowVisualization";
