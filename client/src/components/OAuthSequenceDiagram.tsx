import { useMemo, memo } from "react";
import type { ReactNode } from "react";
import {
  Background,
  Controls,
  Edge,
  EdgeProps,
  Handle,
  Node,
  NodeProps,
  Position,
  ReactFlow,
  EdgeLabelRenderer,
  BaseEdge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { cn } from "@/lib/utils";
import { OauthFlowStateJune2025, OAuthFlowStep } from "@/lib/debug-oauth-state-machine";

type NodeStatus = "complete" | "current" | "pending";

// Actor/Swimlane node types
interface ActorNodeData extends Record<string, unknown> {
  label: string;
  color: string;
  segments: Array<{
    id: string;
    type: "box" | "line";
    height: number;
    handleId?: string;
  }>;
}

// Edge data for action labels
interface ActionEdgeData extends Record<string, unknown> {
  label: string;
  description: string;
  status: NodeStatus;
  details?: Array<{ label: string; value: ReactNode }>;
}

// Actor configuration
const ACTORS = {
  client: { label: "Client", color: "#10b981" }, // Green
  browser: { label: "User-Agent (Browser)", color: "#8b5cf6" }, // Purple
  mcpServer: { label: "MCP Server (Resource Server)", color: "#f59e0b" }, // Orange
  authServer: { label: "Authorization Server", color: "#3b82f6" }, // Blue
};

// Layout constants
const ACTOR_X_POSITIONS = {
  browser: 100,
  client: 350,
  mcpServer: 650,
  authServer: 950,
};
const ACTION_SPACING = 180; // Vertical space between actions
const START_Y = 120; // Initial Y position for first action
const SEGMENT_HEIGHT = 80; // Height of each segment

// Actor Node - Segmented vertical swimlane
const ActorNode = memo((props: NodeProps<Node<ActorNodeData>>) => {
  const { data } = props;
  let currentY = 50;

  return (
    <div className="flex flex-col items-center relative" style={{ width: 140 }}>
      {/* Actor label at top */}
      <div
        className={cn(
          "px-4 py-2 rounded-md font-semibold text-xs border-2 bg-card shadow-sm z-10 mb-2"
        )}
        style={{ borderColor: data.color }}
      >
        {data.label}
      </div>

      {/* Segmented vertical line */}
      <div className="relative" style={{ width: 2 }}>
        {data.segments.map((segment) => {
          const segmentY = currentY;
          currentY += segment.height;

          if (segment.type === "box") {
            return (
              <div
                key={segment.id}
                className="absolute left-1/2 -translate-x-1/2"
                style={{
                  top: segmentY,
                  width: 24,
                  height: segment.height,
                  backgroundColor: data.color,
                  opacity: 0.6,
                  borderRadius: 2,
                }}
              >
                {segment.handleId && (
                  <>
                    <Handle
                      type="source"
                      position={Position.Right}
                      id={`${segment.handleId}-right`}
                      style={{
                        right: -4,
                        top: "50%",
                        background: data.color,
                        width: 8,
                        height: 8,
                        border: "2px solid white",
                      }}
                    />
                    <Handle
                      type="target"
                      position={Position.Left}
                      id={`${segment.handleId}-left`}
                      style={{
                        left: -4,
                        top: "50%",
                        background: data.color,
                        width: 8,
                        height: 8,
                        border: "2px solid white",
                      }}
                    />
                  </>
                )}
              </div>
            );
          } else {
            return (
              <div
                key={segment.id}
                className="absolute left-1/2 -translate-x-1/2"
                style={{
                  top: segmentY,
                  width: 2,
                  height: segment.height,
                  backgroundColor: data.color,
                  opacity: 0.2,
                }}
              />
            );
          }
        })}
      </div>
    </div>
  );
});

ActorNode.displayName = "ActorNode";

// Custom Edge with Label
const CustomActionEdge = memo((props: EdgeProps<Edge<ActionEdgeData>>) => {
  const { sourceX, sourceY, targetX, targetY, data, style } = props;

  if (!data) return null;

  const statusColor = {
    complete: "border-green-500/50 bg-card",
    current: "border-blue-500/70 bg-blue-500/5",
    pending: "border-border bg-muted/30",
  }[data.status];

  const labelX = (sourceX + targetX) / 2;
  const labelY = (sourceY + targetY) / 2;

  return (
    <>
      <BaseEdge path={`M ${sourceX},${sourceY} L ${targetX},${targetY}`} style={style} />
      <EdgeLabelRenderer>
        <div
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: "all",
          }}
        >
          <div
            className={cn(
              "px-3 py-1.5 rounded border text-xs shadow-sm backdrop-blur-sm",
              statusColor
            )}
          >
            <div className="font-medium">{data.label}</div>
            {data.details && data.details.length > 0 && (
              <div className="text-[10px] text-muted-foreground mt-0.5">
                {data.details.map((d, i) => (
                  <div key={i}>
                    {d.label}: {d.value}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </EdgeLabelRenderer>
    </>
  );
});

CustomActionEdge.displayName = "CustomActionEdge";

const nodeTypes = {
  actor: ActorNode,
};

const edgeTypes = {
  actionEdge: CustomActionEdge,
};

interface OAuthSequenceDiagramProps {
  flowState: OauthFlowStateJune2025;
}

// Helper to determine status based on current step
const getActionStatus = (actionStep: OAuthFlowStep | string, currentStep: OAuthFlowStep): NodeStatus => {
  const stepOrder: (OAuthFlowStep | string)[] = [
    "idle",
    "request_without_token",
    "received_401_unauthorized",
    "request_resource_metadata",
    "received_resource_metadata",
    "request_authorization_server_metadata",
    "received_authorization_server_metadata",
    "request_client_registration",
    "received_client_credentials",
    "generate_pkce_parameters",
    "authorization_request",
    "browser_to_auth_server",
    "auth_redirect_to_browser",
    "received_authorization_code",
    "token_request",
    "received_access_token",
    "authenticated_mcp_request",
    "complete",
  ];

  const actionIndex = stepOrder.indexOf(actionStep);
  const currentIndex = stepOrder.indexOf(currentStep);

  if (actionIndex < currentIndex) return "complete";
  if (actionIndex === currentIndex) return "current";
  return "pending";
};

export const OAuthSequenceDiagram = memo(({ flowState }: OAuthSequenceDiagramProps) => {
  const { nodes, edges } = useMemo(() => {
    const currentStep = flowState.currentStep;

    // Define actions in the sequence (matches MCP OAuth spec)
    const actions = [
      {
        id: "request_without_token",
        label: "MCP request without token",
        description: "Client makes initial request without authorization",
        from: "client",
        to: "mcpServer",
        details: flowState.serverUrl
          ? [{ label: "POST", value: flowState.serverUrl }, { label: "method", value: "initialize" }]
          : undefined,
      },
      {
        id: "received_401_unauthorized",
        label: "HTTP 401 Unauthorized",
        description: "Server returns 401 with WWW-Authenticate header",
        from: "mcpServer",
        to: "client",
        details: flowState.resourceMetadataUrl
          ? [{ label: "Note", value: "Extract resource_metadata URL" }]
          : undefined,
      },
      {
        id: "request_resource_metadata",
        label: "Request Protected Resource Metadata",
        description: "Client requests metadata from well-known URI",
        from: "client",
        to: "mcpServer",
        details: flowState.resourceMetadataUrl
          ? [{ label: "GET", value: new URL(flowState.resourceMetadataUrl).pathname }]
          : undefined,
      },
      {
        id: "received_resource_metadata",
        label: "Return metadata",
        description: "Server returns OAuth protected resource metadata",
        from: "mcpServer",
        to: "client",
        details: flowState.resourceMetadata?.authorization_servers
          ? [{ label: "Auth Server", value: flowState.resourceMetadata.authorization_servers[0] }]
          : undefined,
      },
      {
        id: "request_authorization_server_metadata",
        label: "GET /.well-known/oauth-authorization-server",
        description: "Client requests OAuth/OIDC metadata from Authorization Server",
        from: "client",
        to: "authServer",
        details: flowState.authorizationServerUrl
          ? [{ label: "URL", value: flowState.authorizationServerUrl }]
          : undefined,
      },
      {
        id: "received_authorization_server_metadata",
        label: "Authorization server metadata response",
        description: "Authorization Server returns metadata",
        from: "authServer",
        to: "client",
        details: flowState.authorizationServerMetadata
          ? [
              { label: "Token", value: new URL(flowState.authorizationServerMetadata.token_endpoint).pathname },
              { label: "Auth", value: new URL(flowState.authorizationServerMetadata.authorization_endpoint).pathname },
            ]
          : undefined,
      },
      {
        id: "request_client_registration",
        label: "POST /register",
        description: "Client registers dynamically with Authorization Server",
        from: "client",
        to: "authServer",
        details: [{ label: "Note", value: "Dynamic client registration" }],
      },
      {
        id: "received_client_credentials",
        label: "Client Credentials",
        description: "Authorization Server returns client ID and credentials",
        from: "authServer",
        to: "client",
        details: flowState.clientId
          ? [{ label: "client_id", value: flowState.clientId.substring(0, 20) + "..." }]
          : undefined,
      },
      {
        id: "generate_pkce_parameters",
        label: "Generate PKCE parameters",
        description: "Client generates code verifier and challenge",
        from: "client",
        to: "client",
        details: flowState.codeChallenge
          ? [
              { label: "code_challenge", value: flowState.codeChallenge.substring(0, 15) + "..." },
              { label: "method", value: flowState.codeChallengeMethod || "S256" },
            ]
          : undefined,
      },
      {
        id: "authorization_request",
        label: "Open browser with authorization URL",
        description: "Client opens browser with authorization URL + code_challenge + resource",
        from: "client",
        to: "browser",
        details: flowState.authorizationUrl
          ? [
              { label: "code_challenge", value: flowState.codeChallenge?.substring(0, 12) + "..." || "S256" },
              { label: "resource", value: flowState.serverUrl || "" },
            ]
          : undefined,
      },
      {
        id: "browser_to_auth_server",
        label: "Authorization request with resource parameter",
        description: "Browser navigates to authorization endpoint",
        from: "browser",
        to: "authServer",
        details: flowState.authorizationUrl
          ? [
              { label: "Note", value: "User authorizes in browser" },
            ]
          : undefined,
      },
      {
        id: "auth_redirect_to_browser",
        label: "Redirect to callback with authorization code",
        description: "Authorization Server redirects browser back to callback URL",
        from: "authServer",
        to: "browser",
        details: flowState.authorizationCode
          ? [{ label: "code", value: flowState.authorizationCode.substring(0, 20) + "..." }]
          : undefined,
      },
      {
        id: "received_authorization_code",
        label: "Authorization code callback",
        description: "Browser redirects back to client with authorization code",
        from: "browser",
        to: "client",
        details: flowState.authorizationCode
          ? [{ label: "code", value: flowState.authorizationCode.substring(0, 20) + "..." }]
          : undefined,
      },
      {
        id: "token_request",
        label: "Token request + code_verifier + resource",
        description: "Client exchanges authorization code for access token",
        from: "client",
        to: "authServer",
        details: flowState.codeVerifier
          ? [
              { label: "grant_type", value: "authorization_code" },
              { label: "resource", value: flowState.serverUrl || "" },
            ]
          : undefined,
      },
      {
        id: "received_access_token",
        label: "Access token (+ refresh token)",
        description: "Authorization Server returns access token",
        from: "authServer",
        to: "client",
        details: flowState.accessToken
          ? [
              { label: "token_type", value: flowState.tokenType || "Bearer" },
              { label: "expires_in", value: flowState.expiresIn?.toString() || "3600" },
            ]
          : undefined,
      },
      {
        id: "authenticated_mcp_request",
        label: "MCP request with access token",
        description: "Client makes authenticated request to MCP server",
        from: "client",
        to: "mcpServer",
        details: flowState.accessToken
          ? [
              { label: "POST", value: "tools/list" },
              { label: "Authorization", value: "Bearer " + flowState.accessToken.substring(0, 15) + "..." }
            ]
          : undefined,
      },
    ];

    // Calculate total height needed
    const totalActions = actions.length;
    const totalHeight = START_Y + totalActions * ACTION_SPACING;

    // Create segments for each actor (order: Browser, Client, MCP Server, Auth Server)
    const browserSegments: ActorNodeData["segments"] = [];
    const clientSegments: ActorNodeData["segments"] = [];
    const mcpServerSegments: ActorNodeData["segments"] = [];
    const authServerSegments: ActorNodeData["segments"] = [];

    let currentY = 0;

    actions.forEach((action, index) => {
      const actionY = START_Y + index * ACTION_SPACING - START_Y;

      // Add line segments before the action
      if (currentY < actionY) {
        browserSegments.push({
          id: `browser-line-${index}`,
          type: "line",
          height: actionY - currentY,
        });
        clientSegments.push({
          id: `client-line-${index}`,
          type: "line",
          height: actionY - currentY,
        });
        mcpServerSegments.push({
          id: `mcp-line-${index}`,
          type: "line",
          height: actionY - currentY,
        });
        authServerSegments.push({
          id: `auth-line-${index}`,
          type: "line",
          height: actionY - currentY,
        });
        currentY = actionY;
      }

      // Add box segments for the actors involved in this action
      if (action.from === "browser" || action.to === "browser") {
        browserSegments.push({
          id: `browser-box-${action.id}`,
          type: "box",
          height: SEGMENT_HEIGHT,
          handleId: action.id,
        });
      } else {
        browserSegments.push({
          id: `browser-line-action-${index}`,
          type: "line",
          height: SEGMENT_HEIGHT,
        });
      }

      if (action.from === "client" || action.to === "client") {
        clientSegments.push({
          id: `client-box-${action.id}`,
          type: "box",
          height: SEGMENT_HEIGHT,
          handleId: action.id,
        });
      } else {
        clientSegments.push({
          id: `client-line-action-${index}`,
          type: "line",
          height: SEGMENT_HEIGHT,
        });
      }

      if (action.from === "mcpServer" || action.to === "mcpServer") {
        mcpServerSegments.push({
          id: `mcp-box-${action.id}`,
          type: "box",
          height: SEGMENT_HEIGHT,
          handleId: action.id,
        });
      } else {
        mcpServerSegments.push({
          id: `mcp-line-action-${index}`,
          type: "line",
          height: SEGMENT_HEIGHT,
        });
      }

      if (action.from === "authServer" || action.to === "authServer") {
        authServerSegments.push({
          id: `auth-box-${action.id}`,
          type: "box",
          height: SEGMENT_HEIGHT,
          handleId: action.id,
        });
      } else {
        authServerSegments.push({
          id: `auth-line-action-${index}`,
          type: "line",
          height: SEGMENT_HEIGHT,
        });
      }

      currentY += SEGMENT_HEIGHT;
    });

    // Add final line segments
    const remainingHeight = totalHeight - currentY;
    if (remainingHeight > 0) {
      browserSegments.push({
        id: "browser-line-end",
        type: "line",
        height: remainingHeight,
      });
      clientSegments.push({
        id: "client-line-end",
        type: "line",
        height: remainingHeight,
      });
      mcpServerSegments.push({
        id: "mcp-line-end",
        type: "line",
        height: remainingHeight,
      });
      authServerSegments.push({
        id: "auth-line-end",
        type: "line",
        height: remainingHeight,
      });
    }

    // Create actor nodes (left to right: Browser, Client, MCP Server, Auth Server)
    const nodes: Node[] = [
      {
        id: "actor-browser",
        type: "actor",
        position: { x: ACTOR_X_POSITIONS.browser, y: 0 },
        data: {
          label: ACTORS.browser.label,
          color: ACTORS.browser.color,
          segments: browserSegments,
        },
        draggable: false,
      },
      {
        id: "actor-client",
        type: "actor",
        position: { x: ACTOR_X_POSITIONS.client, y: 0 },
        data: {
          label: ACTORS.client.label,
          color: ACTORS.client.color,
          segments: clientSegments,
        },
        draggable: false,
      },
      {
        id: "actor-mcpServer",
        type: "actor",
        position: { x: ACTOR_X_POSITIONS.mcpServer, y: 0 },
        data: {
          label: ACTORS.mcpServer.label,
          color: ACTORS.mcpServer.color,
          segments: mcpServerSegments,
        },
        draggable: false,
      },
      {
        id: "actor-authServer",
        type: "actor",
        position: { x: ACTOR_X_POSITIONS.authServer, y: 0 },
        data: {
          label: ACTORS.authServer.label,
          color: ACTORS.authServer.color,
          segments: authServerSegments,
        },
        draggable: false,
      },
    ];

    // Create action edges
    const edges: Edge[] = actions.map((action, index) => {
      const status = getActionStatus(action.id, currentStep);
      const isComplete = status === "complete";

      // For self-referencing actions (client to client), use special handles
      const isSelfReferencing = action.from === action.to;

      return {
        id: `edge-${action.id}`,
        source: `actor-${action.from}`,
        target: `actor-${action.to}`,
        sourceHandle: isSelfReferencing ? `${action.id}-right` : `${action.id}-right`,
        targetHandle: isSelfReferencing ? `${action.id}-right` : `${action.id}-left`,
        type: "actionEdge",
        data: {
          label: action.label,
          description: action.description,
          status,
          details: action.details,
        },
        animated: isComplete,
        style: {
          stroke: isComplete ? "#10b981" : status === "current" ? "#3b82f6" : "#d1d5db",
          strokeWidth: 2,
        },
      };
    });

    return { nodes, edges };
  }, [flowState]);

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        minZoom={0.5}
        maxZoom={1.5}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
});

OAuthSequenceDiagram.displayName = "OAuthSequenceDiagram";
