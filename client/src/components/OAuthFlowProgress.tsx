import { useMemo, useCallback, memo, useEffect } from "react";
import type { ReactNode } from "react";
import {
  Background,
  Controls,
  Edge,
  Handle,
  Node,
  NodeProps,
  OnInit,
  Position,
  ReactFlow,
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
    type: 'box' | 'line';
    height: number;
    handleId?: string; // For boxes that need handles
  }>;
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
          "px-4 py-2 rounded-md font-semibold text-xs border-2 bg-card shadow-sm z-10 mb-2"
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

          if (segment.type === 'box') {
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
                        top: '50%',
                        background: data.color,
                        width: 8,
                        height: 8,
                        border: '2px solid white',
                      }}
                    />
                    <Handle
                      type="target"
                      position={Position.Left}
                      id={`${segment.handleId}-left`}
                      style={{
                        left: -4,
                        top: '50%',
                        background: data.color,
                        width: 8,
                        height: 8,
                        border: '2px solid white',
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

// Action Node - Simple div with text and handles on left/right
const ActionNode = memo((props: NodeProps<Node<ActionNodeData>>) => {
  const { data } = props;
  const statusColor = {
    complete: "border-green-500/50 bg-card",
    current: "border-blue-500/70 bg-blue-500/5",
    pending: "border-border bg-muted/30",
  }[data.status];

  const isExpanded = data.details || data.input || data.error || data.secondaryAction;

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
          isExpanded ? "min-w-[320px] max-w-[380px] p-3" : "min-w-[280px] max-w-[340px] px-4 py-2.5",
          statusColor
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground truncate">{data.label}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">
              {data.description}
            </p>
          </div>
          {data.status !== "pending" && (
            <Badge variant="outline" className={cn("shrink-0 text-[10px] py-0 px-1.5", STATUS_BADGE_CLASS[data.status])}>
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
                  className={cn("text-xs h-8", data.input.error ? "border-destructive" : undefined)}
                  autoComplete="off"
                />
                {data.input.error && (
                  <p className="text-[10px] text-destructive">{data.input.error}</p>
                )}
              </div>
            )}

            {data.error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2">
                <p className="text-[10px] font-medium text-destructive">{data.error}</p>
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
  onGuardStateChange?: (guard: { canProceed: boolean; reason?: string }) => void;
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
  action: ActionNode,
};

export const OAuthFlowProgress = ({
  flowState,
  updateFlowState,
  onGuardStateChange,
}: OAuthFlowProgressProps) => {
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

  const stepGuards = useMemo<Record<OAuthStep, { canProceed: boolean; reason?: string }>>(
    () => ({
      metadata_discovery: { canProceed: true },
      client_registration: {
        canProceed: !!flowState.oauthMetadata,
        reason: flowState.oauthMetadata
          ? undefined
          : "Waiting for OAuth metadata from the server.",
      },
      authorization_redirect: {
        canProceed:
          !!flowState.oauthClientInfo && !!flowState.oauthMetadata,
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
        getDetails: () => flowState.oauthMetadata ? [
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
        ] : undefined,
        getError: () => flowState.latestError && currentStepIndex === 0 ? flowState.latestError.message : null,
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
        getDetails: () => flowState.oauthClientInfo ? [
          {
            label: "Client ID",
            value: truncateValue(flowState.oauthClientInfo.client_id),
          },
          ...("redirect_uris" in flowState.oauthClientInfo && flowState.oauthClientInfo.redirect_uris ? [{
            label: "Redirect URIs",
            value: formatList(flowState.oauthClientInfo.redirect_uris),
          }] : []),
        ] : undefined,
        getError: () => flowState.latestError && currentStepIndex === 1 ? flowState.latestError.message : null,
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
        getDetails: () => flowState.authorizationUrl ? [
          {
            label: "Authorization URL",
            value: <span className="break-all">{flowState.authorizationUrl}</span>,
          },
        ] : undefined,
        getSecondaryAction: () => flowState.authorizationUrl ? {
          label: "Open in Browser",
          onClick: handleOpenAuthorization,
        } : undefined,
        getError: () => flowState.latestError && currentStepIndex === 2 ? flowState.latestError.message : null,
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
        getError: () => flowState.latestError && currentStepIndex === 3 ? flowState.latestError.message : null,
      },
      {
        id: "token-exchange",
        from: "client",
        to: "authServer",
        label: "Token Exchange",
        description: "POST to token_endpoint with code + PKCE verifier",
        step: "token_request",
        getError: () => flowState.latestError && currentStepIndex === 4 ? flowState.latestError.message : null,
      },
      {
        id: "return-tokens",
        from: "authServer",
        to: "client",
        label: "Return Tokens",
        description: "Access token and refresh token",
        step: "token_request",
        getDetails: () => flowState.oauthTokens ? [
          {
            label: "Access Token",
            value: truncateValue(flowState.oauthTokens.access_token),
          },
          flowState.oauthTokens.refresh_token ? {
            label: "Refresh Token",
            value: truncateValue(flowState.oauthTokens.refresh_token),
          } : undefined,
          flowState.oauthTokens.expires_in ? {
            label: "Expires In",
            value: `${flowState.oauthTokens.expires_in}s`,
          } : undefined,
        ].filter(Boolean) as Array<{ label: string; value: string }> : undefined,
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
      const segments: ActorNodeData['segments'] = [];
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
            type: 'line',
            height: boxTop - currentY,
          });
          currentY = boxTop;
        }

        // Add box segment if this actor is involved in the action, otherwise add line
        if (action.from === actorKey || action.to === actorKey) {
          segments.push({
            id: `${actorKey}-box-${index}`,
            type: 'box',
            height: boxHeight,
            handleId: `${actorKey}-${action.id}`,
          });
        } else {
          // Add line segment if actor is not involved
          segments.push({
            id: `${actorKey}-line-${index}`,
            type: 'line',
            height: boxHeight,
          });
        }
        currentY += boxHeight;
      });

      // Add final line segment to extend the swimlane
      segments.push({
        id: `${actorKey}-line-final`,
        type: 'line',
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
          segments: generateActorSegments('client'),
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
          segments: generateActorSegments('mcpServer'),
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
          segments: generateActorSegments('authServer'),
        },
        selectable: false,
        draggable: false,
      },
    ];

    const actionNodes: Array<Node<ActionNodeData>> = sequenceActions.map((action, index) => {
      const status = statusForStep(action.step);

      // Calculate X position: midpoint between source and target actors
      const fromX = actorX[action.from];
      const toX = actorX[action.to];

      // Position action box at midpoint
      const midpoint = action.from === action.to ? fromX + 150 : (fromX + toX) / 2;
      const x = midpoint - 170; // Center the action node

      // Y position progresses downward with each action
      const y = START_Y + index * ACTION_SPACING;

      return {
        id: action.id,
        type: "action",
        position: { x, y },
        data: {
          label: action.label,
          description: action.description,
          status,
          direction: fromX < toX ? "request" : "response",
          details: action.getDetails?.(),
          input: action.getInput?.(),
          secondaryAction: action.getSecondaryAction?.(),
          error: action.getError?.(),
        },
        selectable: false,
        draggable: false,
      };
    });

    return [...actorNodes, ...actionNodes];
  }, [sequenceActions, statusForStep]);

  // Create edges connecting actor segments to action nodes
  const edges: Array<Edge> = useMemo(() => {
    return sequenceActions.map((action) => {
      const fromActor = action.from;
      const toActor = action.to;

      return [
        // Edge from source actor to action
        {
          id: `edge-${action.id}-from`,
          source: `actor-${fromActor === 'mcpServer' ? 'mcp-server' : fromActor === 'authServer' ? 'auth-server' : fromActor}`,
          sourceHandle: `${fromActor}-${action.id}-right`,
          target: action.id,
          targetHandle: undefined, // Connect to left handle of action
          type: 'straight',
          style: { stroke: ACTORS[fromActor].color, strokeWidth: 2 },
        },
        // Edge from action to target actor
        {
          id: `edge-${action.id}-to`,
          source: action.id,
          sourceHandle: undefined, // Connect from right handle of action
          target: `actor-${toActor === 'mcpServer' ? 'mcp-server' : toActor === 'authServer' ? 'auth-server' : toActor}`,
          targetHandle: `${toActor}-${action.id}-left`,
          type: 'straight',
          style: { stroke: ACTORS[toActor].color, strokeWidth: 2 },
        },
      ];
    }).flat();
  }, [sequenceActions]);

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

  useEffect(() => {
    if (onGuardStateChange) {
      onGuardStateChange({
        canProceed: currentGuard.canProceed,
        reason: currentGuard.reason,
      });
    }
  }, [currentGuard, onGuardStateChange]);

  return (
    <div className="h-full w-full relative bg-background">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnDoubleClick={false}
        zoomOnScroll={true}
        panOnDrag={true}
        defaultEdgeOptions={defaultEdgeOptions}
        onInit={onInit}
        fitView
        minZoom={0.3}
        maxZoom={1.5}
        className="bg-transparent"
      >
        <Background gap={20} size={1} color="hsl(var(--border))" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
};
