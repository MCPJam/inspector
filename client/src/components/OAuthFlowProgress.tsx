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
  MarkerType,
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

interface OAuthFlowNodeData {
  title: string;
  status: NodeStatus;
  summary: string;
  details?: Array<{ label: string; value: ReactNode }>;
  note?: string;
  error?: string | null;
  secondaryAction?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
  };
  input?: {
    label: string;
    value: string;
    placeholder?: string;
    onChange: (value: string) => void;
    error?: string | null;
  };
}

const STEP_TITLES: Record<OAuthStep, string> = {
  metadata_discovery: "Discover Metadata",
  client_registration: "Register Client",
  authorization_redirect: "Authorize User",
  authorization_code: "Capture Code",
  token_request: "Exchange Tokens",
  complete: "Complete",
};

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

const statusBorderClass = (status: NodeStatus) => {
  switch (status) {
    case "complete":
      return "border-green-500/50 shadow-[0_10px_25px_-18px_rgba(16,185,129,0.6)]";
    case "current":
      return "border-blue-500/60 shadow-[0_16px_35px_-20px_rgba(37,99,235,0.7)]";
    default:
      return "border-border";
  }
};

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

const OAuthFlowNode = memo(({ data }: NodeProps<OAuthFlowNodeData>) => {
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <div
        className={cn(
          "min-w-[260px] max-w-[320px] rounded-xl border bg-card p-4",
          statusBorderClass(data.status),
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-foreground">{data.title}</p>
            <p className="text-[11px] text-muted-foreground">{data.summary}</p>
          </div>
          <Badge variant="outline" className={STATUS_BADGE_CLASS[data.status]}>
            {STATUS_LABEL[data.status]}
          </Badge>
        </div>

      {data.details && data.details.length > 0 && (
        <div className="mt-4 space-y-2">
          {data.details.map((detail) => (
            <DetailRow key={detail.label} {...detail} />
          ))}
        </div>
      )}

      {data.input && (
        <div className="mt-4 space-y-2">
          <Label
            htmlFor={`node-input-${data.title}`}
            className="text-[11px] font-medium text-muted-foreground"
          >
            {data.input.label}
          </Label>
          <Input
            id={`node-input-${data.title}`}
            value={data.input.value}
            placeholder={data.input.placeholder}
            onChange={(event) => data.input?.onChange(event.target.value)}
            className={data.input.error ? "border-destructive" : undefined}
            autoComplete="off"
          />
          {data.input.error && (
            <p className="text-[11px] text-destructive">{data.input.error}</p>
          )}
        </div>
      )}

      {data.note && (
        <p className="mt-3 text-[11px] text-muted-foreground">{data.note}</p>
      )}

      {data.error && (
        <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-2">
          <p className="text-[11px] font-medium text-destructive">{data.error}</p>
        </div>
      )}

      {data.secondaryAction && (
        <div className="mt-4 space-y-2">
          <Button
            size="sm"
            variant="outline"
            onClick={data.secondaryAction.onClick}
            disabled={data.secondaryAction.disabled}
          >
            {data.secondaryAction.label}
          </Button>
        </div>
      )}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </>
  );
});

interface OAuthFlowProgressProps {
  serverUrl: string;
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

const nodeTypes = { "oauth-step": OAuthFlowNode };

export const OAuthFlowProgress = ({
  serverUrl,
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

  const nodes: Array<Node<OAuthFlowNodeData>> = useMemo(() => {
    const dataForStep = (step: OAuthStep): OAuthFlowNodeData => {
      const status = statusForStep(step);
      const isCurrent = status === "current";
      const base: OAuthFlowNodeData = {
        title: STEP_TITLES[step],
        status,
        summary: "",
      };

      switch (step) {
        case "metadata_discovery": {
          base.summary =
            status === "complete"
              ? "Completed automatically when the guided flow started."
              : `Discovering OAuth metadata from ${serverUrl}`;
          base.details = flowState.oauthMetadata
            ? [
                {
                  label: "Authorization Server",
                  value: flowState.authServerUrl?.toString() ?? "—",
                },
                {
                  label: "Issuer",
                  value: flowState.oauthMetadata.issuer,
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
                flowState.resource
                  ? {
                      label: "Protected Resource",
                      value: flowState.resource.toString(),
                    }
                  : undefined,
              ].filter(Boolean) as Array<{ label: string; value: string }>
            : undefined;

          if (isCurrent) {
            base.error =
              flowState.latestError ? flowState.latestError.message : null;
          }
          if (flowState.resourceMetadataError) {
            base.note = `Protected resource metadata failed: ${flowState.resourceMetadataError.message}`;
          }
          break;
        }
        case "client_registration": {
          base.summary =
            status === "complete"
              ? "OAuth client registered with the authorization server."
              : "Prepare an OAuth client for this server.";
          base.details = flowState.oauthClientInfo
            ? [
                {
                  label: "Client ID",
                  value: truncateValue(flowState.oauthClientInfo.client_id),
                },
                "client_secret" in flowState.oauthClientInfo &&
                flowState.oauthClientInfo.client_secret
                  ? {
                      label: "Client Secret",
                      value: truncateValue(
                        flowState.oauthClientInfo.client_secret,
                      ),
                    }
                  : undefined,
                {
                  label: "Redirect URIs",
                  value: formatList(flowState.oauthClientInfo.redirect_uris),
                },
                "token_endpoint_auth_method" in flowState.oauthClientInfo &&
                flowState.oauthClientInfo.token_endpoint_auth_method
                  ? {
                      label: "Auth Method",
                      value:
                        flowState.oauthClientInfo.token_endpoint_auth_method,
                    }
                  : undefined,
                "grant_types" in flowState.oauthClientInfo
                  ? {
                      label: "Grant Types",
                      value: formatList(flowState.oauthClientInfo.grant_types),
                    }
                  : undefined,
              ].filter(Boolean) as Array<{ label: string; value: string }>
            : undefined;

          if (isCurrent) {
            base.error =
              flowState.latestError ? flowState.latestError.message : null;
          }
          break;
        }
        case "authorization_redirect": {
          base.summary =
            status === "complete"
              ? "Authorization URL generated."
              : "Open the authorization URL to grant access.";
          base.details = flowState.authorizationUrl
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
            : undefined;

          if (flowState.authorizationUrl) {
            base.secondaryAction = {
              label: "Open in Browser",
              onClick: handleOpenAuthorization,
            };
          }

          if (isCurrent) {
            base.error =
              flowState.latestError ? flowState.latestError.message : null;
          }
          break;
        }
        case "authorization_code": {
          base.summary =
            status === "complete"
              ? "Authorization code captured."
              : "Paste the one-time code returned after authorizing.";
          base.input = {
            label: "Authorization Code",
            value: flowState.authorizationCode,
            placeholder: "Paste the authorization code to continue",
            onChange: handleAuthorizationCodeChange,
            error: flowState.validationError,
          };
          base.note =
            "After approving access in the browser, paste the returned code here.";

          if (isCurrent) {
            base.error =
              flowState.latestError ? flowState.latestError.message : null;
          }
          break;
        }
        case "token_request": {
          base.summary =
            status === "complete"
              ? "OAuth tokens acquired."
              : "Exchange the authorization code for tokens.";
          base.details = flowState.oauthTokens
            ? [
                {
                  label: "Access Token",
                  value: truncateValue(flowState.oauthTokens.access_token),
                },
                flowState.oauthTokens.refresh_token
                  ? {
                      label: "Refresh Token",
                      value: truncateValue(
                        flowState.oauthTokens.refresh_token,
                      ),
                    }
                  : undefined,
                flowState.oauthTokens.expires_in
                  ? {
                      label: "Expires In",
                      value: `${flowState.oauthTokens.expires_in}s`,
                    }
                  : undefined,
                flowState.oauthTokens.scope
                  ? {
                      label: "Scope",
                      value: flowState.oauthTokens.scope,
                    }
                  : undefined,
              ].filter(Boolean) as Array<{ label: string; value: string }>
            : undefined;

          if (isCurrent) {
            base.error =
              flowState.latestError ? flowState.latestError.message : null;
          }
          break;
        }
        case "complete": {
          base.summary =
            "Authentication successful! These tokens are stored for future requests.";
          base.details = flowState.oauthTokens
            ? [
                {
                  label: "Access Token",
                  value: truncateValue(flowState.oauthTokens.access_token),
                },
                flowState.oauthTokens.refresh_token
                  ? {
                      label: "Refresh Token",
                      value: truncateValue(
                        flowState.oauthTokens.refresh_token,
                      ),
                    }
                  : undefined,
                flowState.oauthTokens.expires_in
                  ? {
                      label: "Expires In",
                      value: `${flowState.oauthTokens.expires_in}s`,
                    }
                  : undefined,
                flowState.oauthTokens.scope
                  ? {
                      label: "Scope",
                      value: flowState.oauthTokens.scope,
                    }
                  : undefined,
              ].filter(Boolean) as Array<{ label: string; value: string }>
            : undefined;
          break;
        }
      }

      return base;
    };

    return steps.map((step, index) => ({
      id: step,
      type: "oauth-step",
      position: { x: 0, y: index * 450 },
      data: dataForStep(step),
      selectable: false,
      draggable: false,
    }));
  }, [
    flowState.authServerUrl,
    flowState.authorizationCode,
    flowState.authorizationUrl,
    flowState.latestError,
    flowState.oauthClientInfo,
    flowState.oauthMetadata,
    flowState.oauthStep,
    flowState.oauthTokens,
    flowState.resource,
    flowState.resourceMetadataError,
    flowState.validationError,
    handleAuthorizationCodeChange,
    handleOpenAuthorization,
    serverUrl,
    statusForStep,
  ]);

  const edges: Array<Edge> = useMemo(
    () =>
      steps.slice(1).map((step, index) => {
        const previous = steps[index];
        const targetIndex = steps.indexOf(step);
        const isComplete = targetIndex < currentStepIndex;
        const isCurrent = targetIndex === currentStepIndex;

        // Determine edge color based on status
        let strokeColor: string;
        let markerColor: string;

        if (isComplete) {
          strokeColor = "rgba(16, 185, 129, 0.7)"; // Green for completed
          markerColor = "rgb(16, 185, 129)";
        } else if (isCurrent) {
          strokeColor = "rgba(37, 99, 235, 0.7)"; // Blue for current
          markerColor = "rgb(37, 99, 235)";
        } else {
          strokeColor = "#d4d4d8"; // Gray for pending
          markerColor = "#94a3b8";
        }

        return {
          id: `${previous}-${step}`,
          source: previous,
          target: step,
          type: "smoothstep",
          animated: isComplete || isCurrent,
          style: {
            stroke: strokeColor,
            strokeWidth: isComplete || isCurrent ? 2.5 : 2,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: markerColor,
            width: 20,
            height: 20,
          },
        };
      }),
    [currentStepIndex],
  );

  const defaultEdgeOptions = useMemo(
    () => ({
      type: "smoothstep" as const,
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

  // Debug edges
  useEffect(() => {
    console.log('Nodes:', nodes.length);
    console.log('Edges:', edges);
  }, [nodes, edges]);

  return (
    <div className="h-full w-full">
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
        minZoom={0.1}
        maxZoom={2}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
};
