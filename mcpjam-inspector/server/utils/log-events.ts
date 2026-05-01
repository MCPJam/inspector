export type Environment =
  | "prod"
  | "staging"
  | "preview"
  | "dev"
  | "local"
  | "test";

export type AuthType = "signedIn" | "guest" | "system" | "unknown";

export type WorkspaceRole =
  | "owner"
  | "admin"
  | "member"
  | "guest"
  | "editor"
  | "chat";

export type AccessLevel = "workspace_member" | "shared_chat";
export type Surface = "preview" | "share_link";
export type ServerTransport = "stdio" | "http";

interface CommonLogContext {
  event: LogEventName;
  timestamp: string;
  environment: Environment;
  release: string | null;
  component: string;
  durationMs?: number;

  authType: AuthType;
  userId?: string | null;
  userExternalId?: string | null;
  guestExternalId?: string | null;
  emailDomain?: string | null;
  orgId?: string | null;
  orgPlan?: string | null;
  orgSeatQuantity?: number | null;
  orgCreatedBy?: string | null;
  workspaceId?: string | null;
  workspaceRole?: WorkspaceRole | null;
  accessLevel?: AccessLevel | null;
  serverId?: string | null;
  sessionId?: string | null;
  chatboxId?: string | null;
  surface?: Surface | null;
  serverTransport?: ServerTransport | null;
  statusCode?: number | null;
}

export interface RequestLogContext extends CommonLogContext {
  requestId: string;
  route: string;
  method: string;
}

export interface SystemLogContext extends CommonLogContext {
  requestId: null;
  route: null;
  method: null;
  authType: "system" | "unknown";
}

export type BaseLogContext = RequestLogContext | SystemLogContext;

export type RequestEventMap = {
  "http.request.completed": { statusCode: number };
  "http.request.failed": { statusCode: number; errorCode: string };
  "http.stream.opened": { statusCode: number };
  "http.stream.closed": { statusCode: number; durationMs: number };
  "mcp.oauth.proxy.failed": {
    targetUrlHost: string;
    oauthPhase: "metadata" | "proxy" | "token";
    errorCode: string;
    statusCode?: number;
  };
  "tunnel.created": {
    tunnelKind: "shared" | "server";
    tunnelDomain: string;
    existed: boolean;
    credentialIdPresent?: boolean;
  };
  "tunnel.creation_failed": {
    tunnelKind: "shared" | "server";
    errorCode: string;
    credentialIdPresent?: boolean;
    tunnelDomain?: string;
  };
  "tunnel.record_failed": {
    tunnelKind: "shared" | "server";
    tunnelDomain?: string;
    errorCode: string;
  };
  "chat.session.persist.failed": {
    failureKind: "timeout" | "http_error" | "exception" | "version_conflict";
    statusCode?: number;
    sourceType?: "serverShare" | "chatbox" | "direct";
  };
  "widget.resource.served": {
    widgetType: "mcp_apps" | "chatgpt_apps";
    resourceUri: string;
    cspMode: "permissive" | "widget-declared";
    mimeTypeValid?: boolean;
  };
  "widget.resource.failed": {
    widgetType: "mcp_apps" | "chatgpt_apps";
    resourceUri?: string;
    cspMode?: "permissive" | "widget-declared";
    errorCode: string;
  };
  "mcp.tool.execution.failed": {
    toolName: string;
    serverId?: string;
    errorCode: string;
  };
};

export type SystemEventMap = {
  "mcp.connection.closed_with_pending_requests": { errorCode: string };
  "process.unhandled_rejection": { errorCode: string };
};

export type LogEventName = keyof RequestEventMap | keyof SystemEventMap;

export type RequestEventPayload<E extends keyof RequestEventMap> =
  RequestLogContext & { event: E } & RequestEventMap[E];

export type SystemEventPayload<E extends keyof SystemEventMap> =
  SystemLogContext & { event: E } & SystemEventMap[E];

// Resolve ENVIRONMENT per call (no module-level cache) so changes to
// process.env in tests or after a config reload take effect on the next emit.
// The "missing in production" warning still fires only once via warnedMissingEnv.
let warnedMissingEnv = false;

const ALLOWED_ENVIRONMENTS: Environment[] = [
  "prod",
  "staging",
  "preview",
  "dev",
  "local",
  "test",
];

export function resolveEnvironment(): Environment {
  const fromEnv = process.env.ENVIRONMENT;
  if (fromEnv && ALLOWED_ENVIRONMENTS.includes(fromEnv as Environment)) {
    return fromEnv as Environment;
  }
  if (process.env.NODE_ENV === "test") return "test";
  if (process.env.NODE_ENV === "production") {
    if (!warnedMissingEnv) {
      warnedMissingEnv = true;
      process.stderr.write(
        "[logging] ENVIRONMENT not set in production; defaulting to 'prod'\n",
      );
    }
    return "prod";
  }
  return "dev";
}

export function resolveRelease(): string | null {
  return (
    process.env.RAILWAY_GIT_COMMIT_SHA ??
    process.env.GIT_SHA ??
    null
  );
}
