import { useMemo, useCallback, memo, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Background,
  Controls,
  Edge,
  EdgeProps,
  Handle,
  Node,
  NodeProps,
  OnInit,
  Position,
  ReactFlow,
  getBezierPath,
  EdgeLabelRenderer,
  BaseEdge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { OAuthFlowState, OAuthStep } from "@/lib/oauth-flow-types";
import { cn } from "@/lib/utils";

type NodeStatus = "complete" | "current" | "pending";

// Actor/Swimlane node types
interface ActorNodeData extends Record<string, unknown> {
  label: string;
  color: string;
  segments: Array<{
    id: string;
    type: "box" | "line";
    height: number;
    handleId?: string; // For boxes that need handles
  }>;
}

// Edge data for action labels
interface ActionEdgeData extends Record<string, unknown> {
  label: string;
  description: string;
  status: NodeStatus;
  details?: Array<{ label: string; value: ReactNode }>;
  error?: string | null;
  input?: {
    label: string;
    value: string;
    placeholder?: string;
    onChange: (value: string) => void;
    error?: string | null;
  };
  secondaryAction?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
  };
}

interface ActionNodeData extends Record<string, unknown> {
  label: string;
  description: string;
  status: NodeStatus;
  direction: "request" | "response";
  details?: Array<{ label: string; value: ReactNode }>;
  error?: string | null;
  input?: {
    label: string;
    value: string;
    placeholder?: string;
    onChange: (value: string) => void;
    error?: string | null;
  };
  secondaryAction?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
  };
}

const STATUS_LABEL: Record<NodeStatus, string> = {
  complete: "Complete",
  current: "In Progress",
  pending: "Pending",
};

const STATUS_BADGE_CLASS: Record<NodeStatus, string> = {
  complete: "border-green-500/30 bg-green-500/10 text-green-600",
  current: "border-blue-500/30 bg-blue-500/10 text-blue-600",
  pending: "border-border bg-muted text-muted-foreground",
};

// Actor configuration
const ACTORS = {
  client: { label: "Inspector Client", color: "#10b981" }, // Green
  mcpServer: { label: "MCP Server", color: "#f59e0b" }, // Orange
  authServer: { label: "Authorization Server", color: "#3b82f6" }, // Blue
};

// Layout constants
const ACTION_SPACING = 200; // Vertical space between actions
const START_Y = 150; // Initial Y position for first action

const truncateValue = (value: string | null | undefined, max = 64) => {
  if (!value) return "—";
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

const formatList = (values?: readonly string[]) => {
  if (!values || values.length === 0) return "—";
  return values.join(", ");
};

const DetailRow = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className="space-y-1">
    <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
    <div className="text-[11px] leading-5 break-words text-foreground">
      {value ?? "—"}
    </div>
  </div>
);

// Actor Node - Segmented vertical swimlane with boxes and lines
const ActorNode = memo((props: NodeProps<Node<ActorNodeData>>) => {
  const { data } = props;

  let currentY = 50; // Start below label

  return (
    <div className="flex flex-col items-center relative" style={{ width: 120 }}>
      {/* Actor label at top */}
      <div
        className={cn(
          "px-4 py-2 rounded-md font-semibold text-xs border-2 bg-card shadow-sm z-10 mb-2",
        )}
        style={{ borderColor: data.color }}
      >
        {data.label}
      </div>

      {/* Segmented vertical line with alternating boxes and lines */}
      <div className="relative" style={{ width: 2 }}>
        {data.segments.map((segment, index) => {
          const segmentY = currentY;
          currentY += segment.height;

          if (segment.type === "box") {
            // Colored box segment with handles
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
                {/* Handles for connecting edges */}
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
            // Plain line segment
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

// Custom Edge with Minimal Label
const CustomActionEdge = memo((props: EdgeProps<Edge<ActionEdgeData>>) => {
  const { sourceX, sourceY, targetX, targetY, data, style, id } = props;

  if (!data) return null;

  const statusColor = {
    complete: "border-green-500/50 bg-card",
    current: "border-blue-500/70 bg-blue-500/5",
    pending: "border-border bg-muted/30",
  }[data.status];

  // Calculate label position (center of edge)
  const labelX = (sourceX + targetX) / 2;
  const labelY = (sourceY + targetY) / 2;

  return (
    <>
      {/* The edge line */}
      <BaseEdge
        path={`M ${sourceX},${sourceY} L ${targetX},${targetY}`}
        style={style}
      />

      {/* Minimal label - just action name and status */}
      <EdgeLabelRenderer>
        <div
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: "all",
          }}
          className="nodrag nopan"
        >
          <div
            className={cn(
              "rounded-md border-2 bg-card shadow-sm px-3 py-1.5 cursor-pointer hover:shadow-md transition-shadow",
              statusColor,
            )}
            data-edge-id={id}
          >
            <div className="flex items-center gap-2">
              <p className="text-xs font-medium text-foreground whitespace-nowrap">
                {data.label}
              </p>
              {data.status !== "pending" && (
                <Badge
                  variant="outline"
                  className={cn(
                    "shrink-0 text-[9px] py-0 px-1",
                    STATUS_BADGE_CLASS[data.status],
                  )}
                >
                  {STATUS_LABEL[data.status]}
                </Badge>
              )}
            </div>
          </div>
        </div>
      </EdgeLabelRenderer>
    </>
  );
});

CustomActionEdge.displayName = "CustomActionEdge";

// Side Panel for Step Details
interface StepDetailsPanelProps {
  action: {
    id: string;
    label: string;
    description: string;
    status: NodeStatus;
    details?: Array<{ label: string; value: ReactNode }>;
    input?: {
      label: string;
      value: string;
      placeholder?: string;
      onChange: (value: string) => void;
      error?: string | null;
    };
    secondaryAction?: {
      label: string;
      onClick: () => void;
      disabled?: boolean;
    };
    error?: string | null;
  } | null;
}

const StepDetailsPanel = memo(({ action }: StepDetailsPanelProps) => {
  if (!action) {
    return (
      <div className="w-96 border-l border-border bg-muted/30 p-6 flex items-center justify-center">
        <p className="text-sm text-muted-foreground text-center">
          Select a step to view details
        </p>
      </div>
    );
  }

  const statusColor = {
    complete: "border-green-500/50 bg-green-500/5 text-green-600",
    current: "border-blue-500/70 bg-blue-500/5 text-blue-600",
    pending: "border-border bg-muted/30 text-muted-foreground",
  }[action.status];

  return (
    <div className="w-96 border-l border-border bg-card overflow-y-auto">
      <div className="p-6 space-y-6">
        {/* Header */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-lg font-semibold text-foreground">
              {action.label}
            </h3>
            <Badge
              variant="outline"
              className={cn(
                "text-[10px] py-0.5 px-2",
                STATUS_BADGE_CLASS[action.status],
              )}
            >
              {STATUS_LABEL[action.status]}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">{action.description}</p>
        </div>

        {/* Error */}
        {action.error && (
          <div className="rounded-md border-2 border-destructive/40 bg-destructive/10 p-3">
            <p className="text-xs font-medium text-destructive leading-relaxed">
              {action.error}
            </p>
          </div>
        )}

        {/* Details */}
        {action.details && action.details.length > 0 && (
          <div className="space-y-4">
            <h4 className="text-sm font-semibold text-foreground">Details</h4>
            <div className="space-y-3">
              {action.details.map((detail) => (
                <div key={detail.label} className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">
                    {detail.label}
                  </p>
                  <div className="text-xs leading-relaxed break-words text-foreground bg-muted/50 rounded-md p-2 font-mono">
                    {detail.value ?? "—"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Input */}
        {action.input && (
          <div className="space-y-2">
            <Label htmlFor="step-input" className="text-xs font-medium">
              {action.input.label}
            </Label>
            <Input
              id="step-input"
              value={action.input.value}
              placeholder={action.input.placeholder}
              onChange={(e) => action.input?.onChange(e.target.value)}
              className={cn(
                "text-sm",
                action.input.error ? "border-destructive" : undefined,
              )}
              autoComplete="off"
            />
            {action.input.error && (
              <p className="text-xs text-destructive">{action.input.error}</p>
            )}
          </div>
        )}

        {/* Secondary Action */}
        {action.secondaryAction && (
          <div>
            <Button
              size="sm"
              variant="default"
              onClick={action.secondaryAction.onClick}
              disabled={action.secondaryAction.disabled}
              className="w-full"
            >
              {action.secondaryAction.label}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
});

StepDetailsPanel.displayName = "StepDetailsPanel";

// Action Node - Simple div with text and handles on left/right (DEPRECATED - using edge labels now)
const ActionNode = memo((props: NodeProps<Node<ActionNodeData>>) => {
  const { data } = props;
  const statusColor = {
    complete: "border-green-500/50 bg-card",
    current: "border-blue-500/70 bg-blue-500/5",
    pending: "border-border bg-muted/30",
  }[data.status];

  const isExpanded =
    data.details || data.input || data.error || data.secondaryAction;

  return (
    <>
      {/* Left handle for connections from source actor */}
      <Handle
        type="target"
        position={Position.Left}
        style={{
          left: -4,
          background: "hsl(var(--primary))",
          width: 8,
          height: 8,
          border: "2px solid hsl(var(--background))",
        }}
      />

      <div
        className={cn(
          "rounded-md border-2 bg-card shadow-md",
          isExpanded
            ? "min-w-[320px] max-w-[380px] p-3"
            : "min-w-[280px] max-w-[340px] px-4 py-2.5",
          statusColor,
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground truncate">
              {data.label}
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">
              {data.description}
            </p>
          </div>
          {data.status !== "pending" && (
            <Badge
              variant="outline"
              className={cn(
                "shrink-0 text-[10px] py-0 px-1.5",
                STATUS_BADGE_CLASS[data.status],
              )}
            >
              {STATUS_LABEL[data.status]}
            </Badge>
          )}
        </div>

        {/* Expandable content */}
        {isExpanded && (
          <div className="mt-3 space-y-2">
            {data.details && data.details.length > 0 && (
              <div className="space-y-1.5 pt-2 border-t border-border/50">
                {data.details.map((detail) => (
                  <DetailRow key={detail.label} {...detail} />
                ))}
              </div>
            )}

            {data.input && (
              <div className="space-y-1.5 pt-2 border-t border-border/50">
                <Label
                  htmlFor={`action-input-${data.label}`}
                  className="text-[10px] font-medium text-muted-foreground"
                >
                  {data.input.label}
                </Label>
                <Input
                  id={`action-input-${data.label}`}
                  value={data.input.value}
                  placeholder={data.input.placeholder}
                  onChange={(event) => data.input?.onChange(event.target.value)}
                  className={cn(
                    "text-xs h-8",
                    data.input.error ? "border-destructive" : undefined,
                  )}
                  autoComplete="off"
                />
                {data.input.error && (
                  <p className="text-[10px] text-destructive">
                    {data.input.error}
                  </p>
                )}
              </div>
            )}

            {data.error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2">
                <p className="text-[10px] font-medium text-destructive">
                  {data.error}
                </p>
              </div>
            )}

            {data.secondaryAction && (
              <div className="pt-2 border-t border-border/50">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={data.secondaryAction.onClick}
                  disabled={data.secondaryAction.disabled}
                  className="w-full h-7 text-xs"
                >
                  {data.secondaryAction.label}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Right handle for connections to target actor */}
      <Handle
        type="source"
        position={Position.Right}
        style={{
          right: -4,
          background: "hsl(var(--primary))",
          width: 8,
          height: 8,
          border: "2px solid hsl(var(--background))",
        }}
      />
    </>
  );
});

interface OAuthFlowProgressProps {
  flowState: OAuthFlowState;
  updateFlowState: (updates: Partial<OAuthFlowState>) => void;
  onGuardStateChange?: (guard: {
    canProceed: boolean;
    reason?: string;
  }) => void;
}

const steps: Array<OAuthStep> = [
  "metadata_discovery",
  "client_registration",
  "authorization_redirect",
  "authorization_code",
  "token_request",
  "complete",
];

const nodeTypes = {
  actor: ActorNode,
  action: ActionNode, // Deprecated - keeping for backwards compatibility
};

const edgeTypes = {
  action: CustomActionEdge,
};

export const OAuthFlowProgress = ({
  flowState,
  updateFlowState,
  onGuardStateChange,
}: OAuthFlowProgressProps) => {
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null);

  const currentStepIndex = Math.max(
    steps.findIndex((step) => step === flowState.oauthStep),
    0,
  );

  const statusForStep = useCallback(
    (step: OAuthStep): NodeStatus => {
      const index = steps.indexOf(step);
      if (index < currentStepIndex) return "complete";
      if (index === currentStepIndex) return "current";
      return "pending";
    },
    [currentStepIndex],
  );

  const stepGuards = useMemo<
    Record<OAuthStep, { canProceed: boolean; reason?: string }>
  >(
    () => ({
      metadata_discovery: { canProceed: true },
      client_registration: {
        canProceed: !!flowState.oauthMetadata,
        reason: flowState.oauthMetadata
          ? undefined
          : "Waiting for OAuth metadata from the server.",
      },
      authorization_redirect: {
        canProceed: !!flowState.oauthClientInfo && !!flowState.oauthMetadata,
        reason:
          flowState.oauthClientInfo && flowState.oauthMetadata
            ? undefined
            : "Client registration is still running.",
      },
      authorization_code: {
        canProceed: !!flowState.authorizationUrl,
        reason: flowState.authorizationUrl
          ? undefined
          : "Waiting for the authorization URL.",
      },
      token_request: {
        canProceed: !!flowState.authorizationCode.trim(),
        reason: flowState.authorizationCode.trim()
          ? undefined
          : "Enter the authorization code to continue.",
      },
      complete: { canProceed: false },
    }),
    [
      flowState.authorizationCode,
      flowState.authorizationUrl,
      flowState.oauthClientInfo,
      flowState.oauthMetadata,
    ],
  );

  const handleAuthorizationCodeChange = useCallback(
    (value: string) => {
      updateFlowState({
        authorizationCode: value,
        validationError: null,
      });
    },
    [updateFlowState],
  );

  const handleOpenAuthorization = useCallback(() => {
    if (flowState.authorizationUrl) {
      window.open(flowState.authorizationUrl, "_blank", "noreferrer");
    }
  }, [flowState.authorizationUrl]);

  // Sequence diagram: Define interactions between actors
  const sequenceActions = useMemo(() => {
    type SequenceAction = {
      id: string;
      from: keyof typeof ACTORS;
      to: keyof typeof ACTORS;
      label: string;
      description: string;
      step: OAuthStep;
      getDetails?: () => Array<{ label: string; value: ReactNode }> | undefined;
      getInput?: () => ActionNodeData["input"];
      getSecondaryAction?: () => ActionNodeData["secondaryAction"];
      getError?: () => string | null;
    };

    const actions: SequenceAction[] = [
      {
        id: "discover-metadata",
        from: "client",
        to: "authServer",
        label: "Discover Metadata",
        description: "GET /.well-known/oauth-protected-resource",
        step: "metadata_discovery",
        getDetails: () =>
          flowState.oauthMetadata
            ? [
                {
                  label: "Authorization Server",
                  value: flowState.authServerUrl?.toString() ?? "—",
                },
                {
                  label: "Authorization Endpoint",
                  value: flowState.oauthMetadata.authorization_endpoint,
                },
                {
                  label: "Token Endpoint",
                  value: flowState.oauthMetadata.token_endpoint,
                },
                {
                  label: "Supported Scopes",
                  value: formatList(flowState.oauthMetadata.scopes_supported),
                },
              ]
            : undefined,
        getError: () =>
          flowState.latestError && currentStepIndex === 0
            ? flowState.latestError.message
            : null,
      },
      {
        id: "return-metadata",
        from: "authServer",
        to: "client",
        label: "Return Metadata",
        description: "OAuth server configuration",
        step: "metadata_discovery",
      },
      {
        id: "register-client",
        from: "client",
        to: "authServer",
        label: "Register Client",
        description: "POST to registration_endpoint",
        step: "client_registration",
        getDetails: () =>
          flowState.oauthClientInfo
            ? [
                {
                  label: "Client ID",
                  value: truncateValue(flowState.oauthClientInfo.client_id),
                },
                ...("redirect_uris" in flowState.oauthClientInfo &&
                flowState.oauthClientInfo.redirect_uris
                  ? [
                      {
                        label: "Redirect URIs",
                        value: formatList(
                          flowState.oauthClientInfo.redirect_uris,
                        ),
                      },
                    ]
                  : []),
              ]
            : undefined,
        getError: () =>
          flowState.latestError && currentStepIndex === 1
            ? flowState.latestError.message
            : null,
      },
      {
        id: "return-credentials",
        from: "authServer",
        to: "client",
        label: "Return Client Credentials",
        description: "Client ID and secret",
        step: "client_registration",
      },
      {
        id: "authorization-redirect",
        from: "client",
        to: "authServer",
        label: "Authorization Redirect",
        description: "Redirect user to authorization_endpoint with PKCE",
        step: "authorization_redirect",
        getDetails: () =>
          flowState.authorizationUrl
            ? [
                {
                  label: "Authorization URL",
                  value: (
                    <span className="break-all">
                      {flowState.authorizationUrl}
                    </span>
                  ),
                },
              ]
            : undefined,
        getSecondaryAction: () =>
          flowState.authorizationUrl
            ? {
                label: "Open in Browser",
                onClick: handleOpenAuthorization,
              }
            : undefined,
        getError: () =>
          flowState.latestError && currentStepIndex === 2
            ? flowState.latestError.message
            : null,
      },
      {
        id: "user-consent",
        from: "authServer",
        to: "authServer",
        label: "User Consent",
        description: "User approves/denies access",
        step: "authorization_redirect",
      },
      {
        id: "return-code",
        from: "authServer",
        to: "client",
        label: "Return Authorization Code",
        description: "Redirect back with code parameter",
        step: "authorization_code",
        getInput: () => ({
          label: "Authorization Code",
          value: flowState.authorizationCode,
          placeholder: "Paste the authorization code here",
          onChange: handleAuthorizationCodeChange,
          error: flowState.validationError,
        }),
        getError: () =>
          flowState.latestError && currentStepIndex === 3
            ? flowState.latestError.message
            : null,
      },
      {
        id: "token-exchange",
        from: "client",
        to: "authServer",
        label: "Token Exchange",
        description: "POST to token_endpoint with code + PKCE verifier",
        step: "token_request",
        getError: () =>
          flowState.latestError && currentStepIndex === 4
            ? flowState.latestError.message
            : null,
      },
      {
        id: "return-tokens",
        from: "authServer",
        to: "client",
        label: "Return Tokens",
        description: "Access token and refresh token",
        step: "token_request",
        getDetails: () =>
          flowState.oauthTokens
            ? ([
                {
                  label: "Access Token",
                  value: truncateValue(flowState.oauthTokens.access_token),
                },
                flowState.oauthTokens.refresh_token
                  ? {
                      label: "Refresh Token",
                      value: truncateValue(flowState.oauthTokens.refresh_token),
                    }
                  : undefined,
                flowState.oauthTokens.expires_in
                  ? {
                      label: "Expires In",
                      value: `${flowState.oauthTokens.expires_in}s`,
                    }
                  : undefined,
              ].filter(Boolean) as Array<{ label: string; value: string }>)
            : undefined,
      },
      {
        id: "authenticated-request",
        from: "client",
        to: "mcpServer",
        label: "Authenticated Request",
        description: "Request with Bearer token in Authorization header",
        step: "complete",
      },
      {
        id: "return-data",
        from: "mcpServer",
        to: "client",
        label: "Return Protected Data",
        description: "Success response with MCP data",
        step: "complete",
      },
    ];

    return actions;
  }, [
    flowState.oauthMetadata,
    flowState.oauthClientInfo,
    flowState.authorizationUrl,
    flowState.authorizationCode,
    flowState.oauthTokens,
    flowState.latestError,
    flowState.validationError,
    flowState.authServerUrl,
    currentStepIndex,
    handleOpenAuthorization,
    handleAuthorizationCodeChange,
  ]);

  const nodes: Array<Node> = useMemo(() => {
    // Actor positions (horizontal spacing)
    const actorX = {
      client: 100,
      mcpServer: 550,
      authServer: 1000,
    };

    // Generate segments for each actor based on actions
    // Segments are positioned to align box centers with action Y positions for horizontal edges
    const generateActorSegments = (actorKey: keyof typeof ACTORS) => {
      const segments: ActorNodeData["segments"] = [];
      let currentY = 50; // Start below label

      sequenceActions.forEach((action, index) => {
        const actionY = START_Y + index * ACTION_SPACING;
        const boxHeight = 80;
        const boxCenter = actionY; // We want the box center to align with the action node
        const boxTop = boxCenter - boxHeight / 2;

        // Add line segment to reach the box top position
        if (boxTop > currentY) {
          segments.push({
            id: `${actorKey}-line-before-${index}`,
            type: "line",
            height: boxTop - currentY,
          });
          currentY = boxTop;
        }

        // Add box segment if this actor is involved in the action, otherwise add line
        if (action.from === actorKey || action.to === actorKey) {
          segments.push({
            id: `${actorKey}-box-${index}`,
            type: "box",
            height: boxHeight,
            handleId: `${actorKey}-${action.id}`,
          });
        } else {
          // Add line segment if actor is not involved
          segments.push({
            id: `${actorKey}-line-${index}`,
            type: "line",
            height: boxHeight,
          });
        }
        currentY += boxHeight;
      });

      // Add final line segment to extend the swimlane
      segments.push({
        id: `${actorKey}-line-final`,
        type: "line",
        height: 100,
      });

      return segments;
    };

    const actorNodes: Array<Node<ActorNodeData>> = [
      {
        id: "actor-client",
        type: "actor",
        position: { x: actorX.client, y: 0 },
        data: {
          ...ACTORS.client,
          segments: generateActorSegments("client"),
        },
        selectable: false,
        draggable: false,
      },
      {
        id: "actor-mcp-server",
        type: "actor",
        position: { x: actorX.mcpServer, y: 0 },
        data: {
          ...ACTORS.mcpServer,
          segments: generateActorSegments("mcpServer"),
        },
        selectable: false,
        draggable: false,
      },
      {
        id: "actor-auth-server",
        type: "actor",
        position: { x: actorX.authServer, y: 0 },
        data: {
          ...ACTORS.authServer,
          segments: generateActorSegments("authServer"),
        },
        selectable: false,
        draggable: false,
      },
    ];

    // No action nodes - actions are rendered as edge labels
    return actorNodes;
  }, [sequenceActions, statusForStep]);

  // Create edges directly between actor segments with action data as labels
  const edges: Array<Edge<ActionEdgeData>> = useMemo(() => {
    return sequenceActions.map((action) => {
      const fromActor = action.from;
      const toActor = action.to;
      const status = statusForStep(action.step);

      // Convert actor key to node ID
      const getActorNodeId = (actorKey: keyof typeof ACTORS) => {
        return `actor-${actorKey === "mcpServer" ? "mcp-server" : actorKey === "authServer" ? "auth-server" : actorKey}`;
      };

      return {
        id: `edge-${action.id}`,
        source: getActorNodeId(fromActor),
        sourceHandle: `${fromActor}-${action.id}-right`,
        target: getActorNodeId(toActor),
        targetHandle: `${toActor}-${action.id}-left`,
        type: "action", // Use our custom action edge type
        style: {
          stroke: ACTORS[fromActor].color,
          strokeWidth: 2,
        },
        data: {
          label: action.label,
          description: action.description,
          status,
          details: action.getDetails?.(),
          input: action.getInput?.(),
          secondaryAction: action.getSecondaryAction?.(),
          error: action.getError?.(),
        },
      };
    });
  }, [sequenceActions, statusForStep]);

  const defaultEdgeOptions = useMemo(
    () => ({
      type: "straight" as const,
    }),
    [],
  );

  const onInit = useCallback<OnInit>((instance) => {
    instance.fitView({ padding: 0.25, duration: 300 });
  }, []);

  const currentGuard = stepGuards[flowState.oauthStep];

  // Find the action to display in the side panel
  const selectedAction = useMemo(() => {
    // If an action is selected, use that
    if (selectedActionId) {
      const action = sequenceActions.find((a) => a.id === selectedActionId);
      if (action) {
        return {
          id: action.id,
          label: action.label,
          description: action.description,
          status: statusForStep(action.step),
          details: action.getDetails?.(),
          input: action.getInput?.(),
          secondaryAction: action.getSecondaryAction?.(),
          error: action.getError?.(),
        };
      }
    }

    // Otherwise, show the current step
    const currentAction = sequenceActions.find(
      (a) => statusForStep(a.step) === "current",
    );
    if (currentAction) {
      return {
        id: currentAction.id,
        label: currentAction.label,
        description: currentAction.description,
        status: statusForStep(currentAction.step),
        details: currentAction.getDetails?.(),
        input: currentAction.getInput?.(),
        secondaryAction: currentAction.getSecondaryAction?.(),
        error: currentAction.getError?.(),
      };
    }

    return null;
  }, [selectedActionId, sequenceActions, statusForStep]);

  // Handle edge clicks
  const handleEdgeClick = useCallback((event: React.MouseEvent, edge: Edge) => {
    // Extract action ID from edge ID (format: "edge-{actionId}")
    const actionId = edge.id.replace("edge-", "");
    setSelectedActionId(actionId);
  }, []);

  useEffect(() => {
    if (onGuardStateChange) {
      onGuardStateChange({
        canProceed: currentGuard.canProceed,
        reason: currentGuard.reason,
      });
    }
  }, [currentGuard, onGuardStateChange]);

  return (
    <div className="h-full w-full flex bg-background">
      {/* Sequence Diagram */}
      <div className="flex-1 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={true}
          zoomOnDoubleClick={false}
          zoomOnScroll={true}
          panOnDrag={true}
          defaultEdgeOptions={defaultEdgeOptions}
          onInit={onInit}
          onEdgeClick={handleEdgeClick}
          fitView
          minZoom={0.3}
          maxZoom={1.5}
          className="bg-transparent"
        >
          <Background gap={20} size={1} color="hsl(var(--border))" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      {/* Side Panel */}
      <StepDetailsPanel action={selectedAction} />
    </div>
  );
};
