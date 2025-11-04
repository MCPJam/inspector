import { useMemo, memo, useEffect } from "react";
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
  useReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { cn } from "@/lib/utils";
import {
  OauthFlowStateJune2025,
  OAuthFlowStep,
  OAuthProtocolVersion,
} from "@/lib/debug-oauth-state-machine";

type NodeStatus = "complete" | "current" | "pending";

// Actor/Swimlane node types
interface ActorNodeData extends Record<string, unknown> {
  label: string;
  color: string;
  totalHeight: number; // Total height for alignment
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
      {/* Actor label at top - fixed height for consistent alignment */}
      <div
        className={cn(
          "px-4 py-2 rounded-md font-semibold text-xs border-2 bg-card shadow-sm z-10 mb-2 flex items-center justify-center text-center",
        )}
        style={{
          borderColor: data.color,
          height: "52px",
          minHeight: "52px",
          width: "130px",
        }}
      >
        {data.label}
      </div>

      {/* Segmented vertical line */}
      <div className="relative" style={{ width: 2, height: data.totalHeight }}>
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
                    {/* Right side handles - both source and target for bidirectional flow */}
                    <Handle
                      type="source"
                      position={Position.Right}
                      id={`${segment.handleId}-right-source`}
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
                      position={Position.Right}
                      id={`${segment.handleId}-right-target`}
                      style={{
                        right: -4,
                        top: "50%",
                        background: data.color,
                        width: 8,
                        height: 8,
                        border: "2px solid white",
                      }}
                    />
                    {/* Left side handles - both source and target for bidirectional flow */}
                    <Handle
                      type="source"
                      position={Position.Left}
                      id={`${segment.handleId}-left-source`}
                      style={{
                        left: -4,
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
                      id={`${segment.handleId}-left-target`}
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

      {/* Actor label at bottom - fixed height for consistent alignment */}
      <div
        className={cn(
          "px-4 py-2 rounded-md font-semibold text-xs border-2 bg-card shadow-sm z-10 mt-2 flex items-center justify-center text-center",
        )}
        style={{
          borderColor: data.color,
          height: "52px",
          minHeight: "52px",
          width: "130px",
        }}
      >
        {data.label}
      </div>
    </div>
  );
});

ActorNode.displayName = "ActorNode";

// Custom Edge with Label
const CustomActionEdge = memo((props: EdgeProps<Edge<ActionEdgeData>>) => {
  const { sourceX, sourceY, targetX, targetY, data, style, markerEnd } = props;

  if (!data) return null;

  const statusColor = {
    complete: "border-green-500/50 bg-green-50 dark:bg-green-950/20",
    current:
      "border-blue-500 bg-blue-100 dark:bg-blue-950/30 shadow-lg shadow-blue-500/20 animate-pulse",
    pending: "border-border bg-muted/30",
  }[data.status];

  const labelX = (sourceX + targetX) / 2;
  const labelY = (sourceY + targetY) / 2;

  return (
    <>
      <BaseEdge
        path={`M ${sourceX},${sourceY} L ${targetX},${targetY}`}
        style={style}
        markerEnd={markerEnd}
      />
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
              statusColor,
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
  registrationStrategy?: "cimd" | "dcr" | "preregistered";
  protocolVersion?: OAuthProtocolVersion;
}

// Helper to determine status based on current step and actual action order
const getActionStatus = (
  actionStep: OAuthFlowStep | string,
  currentStep: OAuthFlowStep,
  actionsInFlow: Array<{ id: string }>,
): NodeStatus => {
  // Find indices in the actual flow (not a hardcoded order)
  const actionIndex = actionsInFlow.findIndex((a) => a.id === actionStep);
  const currentIndex = actionsInFlow.findIndex((a) => a.id === currentStep);

  // If step not found in flow, it's pending
  if (actionIndex === -1) return "pending";

  // Show completed steps (everything up to and including current)
  if (actionIndex <= currentIndex) return "complete";
  // Show the NEXT step as current (what will happen when you click Next Step)
  if (actionIndex === currentIndex + 1) return "current";
  return "pending";
};

// Internal component that has access to ReactFlow instance
const DiagramContent = memo(
  ({
    flowState,
    registrationStrategy = "cimd",
    protocolVersion = "2025-11-25",
  }: OAuthSequenceDiagramProps) => {
    const reactFlowInstance = useReactFlow();

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
            ? [
                { label: "POST", value: flowState.serverUrl },
                { label: "method", value: "initialize" },
              ]
            : undefined,
        },
        {
          id: "received_401_unauthorized",
          label: "HTTP 401 Unauthorized with WWW-Authenticate header",
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
            ? [
                {
                  label: "GET",
                  value: new URL(flowState.resourceMetadataUrl).pathname,
                },
              ]
            : undefined,
        },
        {
          id: "received_resource_metadata",
          label: "Return metadata",
          description: "Server returns OAuth protected resource metadata",
          from: "mcpServer",
          to: "client",
          details: flowState.resourceMetadata?.authorization_servers
            ? [
                {
                  label: "Auth Server",
                  value: flowState.resourceMetadata.authorization_servers[0],
                },
              ]
            : undefined,
        },
        {
          id: "request_authorization_server_metadata",
          label:
            protocolVersion === "2025-11-25"
              ? "GET Authorization server metadata endpoint"
              : "GET /.well-known/oauth-authorization-server",
          description:
            protocolVersion === "2025-11-25"
              ? "Try OAuth path insertion, OIDC path insertion, OIDC path appending"
              : "Try RFC8414 path, then RFC8414 root (no OIDC support)",
          from: "client",
          to: "authServer",
          details: flowState.authorizationServerUrl
            ? [
                { label: "URL", value: flowState.authorizationServerUrl },
                { label: "Protocol", value: protocolVersion },
              ]
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
                {
                  label: "Token",
                  value: new URL(
                    flowState.authorizationServerMetadata.token_endpoint,
                  ).pathname,
                },
                {
                  label: "Auth",
                  value: new URL(
                    flowState.authorizationServerMetadata.authorization_endpoint,
                  ).pathname,
                },
              ]
            : undefined,
        },
        // Client registration steps - conditionally included based on strategy
        ...(registrationStrategy === "cimd"
          ? [
              {
                id: "cimd_prepare",
                label: "Client uses HTTPS URL as client_id",
                description:
                  "Client prepares to use URL-based client identification",
                from: "client",
                to: "client",
                details: flowState.clientId
                  ? [
                      {
                        label: "client_id (URL)",
                        value: flowState.clientId.includes("http")
                          ? flowState.clientId
                          : "https://www.mcpjam.com/.well-known/oauth/client-metadata.json",
                      },
                      {
                        label: "Method",
                        value: "Client ID Metadata Document (CIMD)",
                      },
                    ]
                  : [
                      {
                        label: "Note",
                        value: "HTTPS URL points to metadata document",
                      },
                    ],
              },
              {
                id: "cimd_fetch_request",
                label:
                  "Fetch metadata from client_id URL",
                description:
                  "Authorization Server fetches client metadata from the URL",
                from: "authServer",
                to: "client",
                details: [
                  {
                    label: "Action",
                    value: "GET client_id URL",
                  },
                  {
                    label: "Note",
                    value:
                      "Server initiates metadata fetch during authorization",
                  },
                ],
              },
              {
                id: "cimd_metadata_response",
                label: "JSON metadata document",
                description:
                  "Client hosting returns metadata with redirect_uris and client info",
                from: "client",
                to: "authServer",
                details: [
                  {
                    label: "Content-Type",
                    value: "application/json",
                  },
                  {
                    label: "Contains",
                    value: "client_id, client_name, redirect_uris, etc.",
                  },
                ],
              },
              {
                id: "received_client_credentials",
                label: "Validate metadata and redirect_uris",
                description: "Authorization Server validates fetched metadata",
                from: "authServer",
                to: "authServer",
                details: [
                  {
                    label: "Validates",
                    value: "client_id matches URL, redirect_uris are valid",
                  },
                  {
                    label: "Security",
                    value: "SSRF protection, domain trust policies",
                  },
                ],
              },
            ]
          : registrationStrategy === "dcr"
            ? [
                {
                  id: "request_client_registration",
                  label: `POST /register (${protocolVersion})`,
                  description:
                    "Client registers dynamically with Authorization Server",
                  from: "client",
                  to: "authServer",
                  details: [
                    {
                      label: "Note",
                      value: "Dynamic client registration (DCR)",
                    },
                  ],
                },
                {
                  id: "received_client_credentials",
                  label: "Client Credentials",
                  description:
                    "Authorization Server returns client ID and credentials",
                  from: "authServer",
                  to: "client",
                  details: flowState.clientId
                    ? [
                        {
                          label: "client_id",
                          value: flowState.clientId.substring(0, 20) + "...",
                        },
                      ]
                    : undefined,
                },
              ]
            : [
                {
                  id: "received_client_credentials",
                  label: `Use Pre-registered Client (${protocolVersion})`,
                  description:
                    "Client uses pre-configured credentials (skipped DCR)",
                  from: "client",
                  to: "client",
                  details: flowState.clientId
                    ? [
                        {
                          label: "client_id",
                          value: flowState.clientId.substring(0, 20) + "...",
                        },
                        {
                          label: "Note",
                          value: "Pre-registered (no DCR needed)",
                        },
                      ]
                    : [
                        {
                          label: "Note",
                          value: "Pre-registered client credentials",
                        },
                      ],
                },
              ]),
        {
          id: "generate_pkce_parameters",
          label:
            protocolVersion === "2025-11-25"
              ? "Generate PKCE (REQUIRED)\nInclude resource parameter"
              : "Generate PKCE parameters",
          description:
            protocolVersion === "2025-11-25"
              ? "Client generates code verifier and challenge (REQUIRED), includes resource parameter"
              : "Client generates code verifier and challenge (recommended), includes resource parameter",
          from: "client",
          to: "client",
          details: flowState.codeChallenge
            ? [
                {
                  label: "code_challenge",
                  value: flowState.codeChallenge.substring(0, 15) + "...",
                },
                {
                  label: "method",
                  value: flowState.codeChallengeMethod || "S256",
                },
                { label: "resource", value: flowState.serverUrl || "—" },
                { label: "Protocol", value: protocolVersion },
              ]
            : undefined,
        },
        {
          id: "authorization_request",
          label: "Open browser with authorization URL",
          description:
            "Client opens browser with authorization URL + code_challenge + resource",
          from: "client",
          to: "browser",
          details: flowState.authorizationUrl
            ? [
                {
                  label: "code_challenge",
                  value:
                    flowState.codeChallenge?.substring(0, 12) + "..." || "S256",
                },
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
            ? [{ label: "Note", value: "User authorizes in browser" }]
            : undefined,
        },
        {
          id: "auth_redirect_to_browser",
          label: "Redirect to callback with authorization code",
          description:
            "Authorization Server redirects browser back to callback URL",
          from: "authServer",
          to: "browser",
          details: flowState.authorizationCode
            ? [
                {
                  label: "code",
                  value: flowState.authorizationCode.substring(0, 20) + "...",
                },
              ]
            : undefined,
        },
        {
          id: "received_authorization_code",
          label: "Authorization code callback",
          description:
            "Browser redirects back to client with authorization code",
          from: "browser",
          to: "client",
          details: flowState.authorizationCode
            ? [
                {
                  label: "code",
                  value: flowState.authorizationCode.substring(0, 20) + "...",
                },
              ]
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
                {
                  label: "expires_in",
                  value: flowState.expiresIn?.toString() || "3600",
                },
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
                {
                  label: "Authorization",
                  value:
                    "Bearer " + flowState.accessToken.substring(0, 15) + "...",
                },
              ]
            : undefined,
        },
        {
          id: "complete",
          label: "MCP response",
          description: "MCP Server returns successful response",
          from: "mcpServer",
          to: "client",
          details: flowState.accessToken
            ? [
                { label: "Status", value: "200 OK" },
                { label: "Content", value: "tools, resources, prompts" },
              ]
            : undefined,
        },
      ];

      // Calculate total height needed for segments
      const totalActions = actions.length;
      // Total segment height: space for all actions + a final buffer
      const totalSegmentHeight = totalActions * ACTION_SPACING + 100;

      // Create segments for each actor (order: Browser, Client, MCP Server, Auth Server)
      const browserSegments: ActorNodeData["segments"] = [];
      const clientSegments: ActorNodeData["segments"] = [];
      const mcpServerSegments: ActorNodeData["segments"] = [];
      const authServerSegments: ActorNodeData["segments"] = [];

      let currentY = 0;

      actions.forEach((action, index) => {
        const actionY = index * ACTION_SPACING;

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

      // Add final line segments to reach the same total height for all actors
      const remainingHeight = totalSegmentHeight - currentY;
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
            totalHeight: totalSegmentHeight,
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
            totalHeight: totalSegmentHeight,
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
            totalHeight: totalSegmentHeight,
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
            totalHeight: totalSegmentHeight,
            segments: authServerSegments,
          },
          draggable: false,
        },
      ];

      // Create action edges
      const edges: Edge[] = actions.map((action, index) => {
        const status = getActionStatus(action.id, currentStep, actions);
        const isComplete = status === "complete";
        const isCurrent = status === "current";
        const isPending = status === "pending";

        // Determine arrow color based on status
        const arrowColor = isComplete
          ? "#10b981"
          : isCurrent
            ? "#3b82f6"
            : "#d1d5db";

        // Determine handle positions based on flow direction
        const sourceX =
          ACTOR_X_POSITIONS[action.from as keyof typeof ACTOR_X_POSITIONS];
        const targetX =
          ACTOR_X_POSITIONS[action.to as keyof typeof ACTOR_X_POSITIONS];
        const isLeftToRight = sourceX < targetX;

        return {
          id: `edge-${action.id}`,
          source: `actor-${action.from}`,
          target: `actor-${action.to}`,
          sourceHandle: isLeftToRight
            ? `${action.id}-right-source`
            : `${action.id}-left-source`,
          targetHandle: isLeftToRight
            ? `${action.id}-left-target`
            : `${action.id}-right-target`,
          type: "actionEdge",
          data: {
            label: action.label,
            description: action.description,
            status,
            details: action.details,
          },
          animated: isCurrent, // Only animate current step
          markerEnd: {
            type: "arrowclosed" as const,
            color: arrowColor,
            width: 12,
            height: 12,
          },
          style: {
            stroke: arrowColor,
            strokeWidth: isCurrent ? 3 : isComplete ? 2 : 1.5,
            strokeDasharray: isCurrent ? "5,5" : undefined, // Only current step is dashed
            opacity: isPending ? 0.4 : 1, // Dim pending edges
          },
        };
      });

      return { nodes, edges };
    }, [flowState, registrationStrategy, protocolVersion]);

    // Auto-zoom to current step
    useEffect(() => {
      if (!reactFlowInstance || !flowState.currentStep) {
        return;
      }

      // Small delay to ensure nodes are rendered
      const timer = setTimeout(() => {
        // If reset to idle, zoom back to the top
        if (flowState.currentStep === "idle") {
          // Zoom to the top of the diagram
          // Center around the middle actors (Client and MCP Server)
          reactFlowInstance.setCenter(550, 200, {
            zoom: 0.8,
            duration: 800,
          });
          return;
        }

        // Don't zoom when flow is complete - let user stay at current position
        if (flowState.currentStep === "complete") {
          return;
        }

        // Find the edge that has "current" status (the next step to execute)
        const currentEdge = edges.find((e) => e.data?.status === "current");

        if (currentEdge) {
          // Get source and target actor positions
          const sourceNode = nodes.find((n) => n.id === currentEdge.source);
          const targetNode = nodes.find((n) => n.id === currentEdge.target);

          if (sourceNode && targetNode) {
            // Find the action index to calculate Y position
            const actionIndex = edges.findIndex((e) => e.id === currentEdge.id);

            // Calculate positions
            // Actor nodes have a header (~52px) + some padding (~50px)
            // Each action segment is ACTION_SPACING (180) apart
            const headerOffset = 102;
            const actionY = headerOffset + actionIndex * 180 + 40; // 40 is half of SEGMENT_HEIGHT
            const centerX =
              (sourceNode.position.x + targetNode.position.x) / 2 + 70; // +70 to account for node width
            const centerY = actionY;

            // Zoom into the current step with animation
            reactFlowInstance.setCenter(centerX, centerY, {
              zoom: 1.2,
              duration: 800,
            });
          }
        }
      }, 100);

      return () => clearTimeout(timer);
    }, [flowState.currentStep, edges, nodes, reactFlowInstance]);

    return (
      <div className="w-full h-full">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          minZoom={0.4}
          maxZoom={2}
          defaultViewport={{ x: 0, y: 0, zoom: 0.8 }}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnScroll={true}
          zoomOnScroll={true}
          zoomOnPinch={true}
          panOnDrag={true}
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    );
  },
);

DiagramContent.displayName = "DiagramContent";

// Wrapper component with ReactFlowProvider
export const OAuthSequenceDiagram = memo((props: OAuthSequenceDiagramProps) => {
  return (
    <ReactFlowProvider>
      <DiagramContent {...props} />
    </ReactFlowProvider>
  );
});

OAuthSequenceDiagram.displayName = "OAuthSequenceDiagram";
