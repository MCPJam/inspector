import type { MCPServerConfig, NormalizedError } from "@mcpjam/sdk/browser";
import { OauthTokens } from "@/shared/types.js";
import type { OAuthTestProfile } from "@/lib/oauth/profile";
import type {
  ProjectClientConfig,
  ProjectConnectionDefaults,
} from "@/lib/client-config";
import type { OAuthTrace } from "@/lib/oauth/oauth-trace";

export type ConnectionStatus =
  | "connected"
  | "connecting"
  | "failed"
  | "disconnected"
  | "oauth-flow";

export type ProjectVisibility = "public" | "private";

export interface InitializationInfo {
  protocolVersion?: string;
  transport?: string;
  serverCapabilities?: Record<string, any>;
  serverVersion?: {
    name: string;
    version: string;
    title?: string;
    websiteUrl?: string;
    icons?: Array<{
      src: string;
      mimeType?: string;
      sizes?: string[];
    }>;
  };
  instructions?: string;
  clientCapabilities?: Record<string, any>;
}

export interface ServerWithName {
  name: string;
  config: MCPServerConfig;
  oauthTokens?: OauthTokens;
  oauthFlowProfile?: OAuthTestProfile;
  initializationInfo?: InitializationInfo;
  lastConnectionTime: Date;
  connectionStatus: ConnectionStatus;
  retryCount: number;
  lastError?: string;
  /**
   * Rich describe-error block for the last connection failure. Populated
   * alongside `lastError` whenever the source carried a `normalized`
   * payload. `lastError` is kept as a back-compat string field — readers
   * should prefer `lastNormalizedError` and fall back to `lastError`.
   */
  lastNormalizedError?: NormalizedError;
  lastOAuthTrace?: OAuthTrace;
  enabled?: boolean;
  /** Whether OAuth is explicitly enabled for this server. When false, reconnect skips OAuth flow. */
  useOAuth?: boolean;
  hasClientSecret?: boolean;
  hasEnv?: boolean;
  hasHeaders?: boolean;
  /**
   * Whether a redacted HTTP config carried an `Authorization: Bearer …`
   * header. The header value itself is stripped before reaching the browser
   * (like env/headers), so the edit form relies on this flag to know the
   * server uses bearer auth and to keep the saved token hidden-but-preserved.
   */
  hasBearerToken?: boolean;
  /**
   * Optional issuer override for the cross-app authorization test target.
   * XAA metadata only — intentionally NOT part of MCPServerConfig / toMCPConfig.
   */
  xaaAuthzIssuer?: string;
  /**
   * Cross-App Access (XAA) connect flag. When true the server authenticates via
   * the XAA token-exchange flow (server mints the token) rather than standard
   * OAuth. Mutually exclusive with `useOAuth`.
   */
  useXaa?: boolean;
  /** Which IdP mints the XAA assertion. v1 only "mcpjam". */
  authServerMode?: "mcpjam" | "own";
  /**
   * Which identity provider mints the XAA assertion — orthogonal to
   * `authServerMode`. "mcpjam" (default) self-mints; "external" runs legs 1+2
   * against a real OIDC IdP. See `shared/xaa-grants.ts`.
   */
  idpMode?: "mcpjam" | "external";
  /** Optional simulated-identity overrides for the MCPJam test IdP. Blank = signed-in user. */
  xaaSubject?: string;
  xaaEmail?: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  /**
   * @deprecated Backend-maintained shadow-mirror of the project default host
   * (`hostConfigsV2.getProjectDefault`). UI reads should go through
   * `useAppState().activeHost` (which resolves the top-bar selection → project
   * default). Kept on the type only as a transient bootstrap fallback for the
   * window before the host query hydrates; will be dropped once that gap can
   * be guaranteed-closed by `isClientConfigSyncPending`.
   */
  clientConfig?: ProjectClientConfig;
  servers: Record<string, ServerWithName>;
  createdAt: Date;
  updatedAt: Date;
  canDeleteProject?: boolean;
  isDefault?: boolean;
  sharedProjectId?: string;
  organizationId?: string;
  visibility?: ProjectVisibility;
}

/**
 * Resolve a project from either id space. `AppState.projects` is keyed by
 * local project ids, but several surfaces carry the Convex/shared project
 * id instead (App.tsx's `convexProjectId` props, eval run rows'
 * `projectId`). Key lookup wins; otherwise fall back to a
 * `sharedProjectId` match.
 */
export function findProjectByAnyId(
  projects: Record<string, Project> | undefined,
  id: string | null | undefined,
): Project | undefined {
  if (!id) return undefined;
  const byKey = projects?.[id];
  if (byKey) return byKey;
  return Object.values(projects ?? {}).find(
    (project) => project.sharedProjectId === id,
  );
}

export interface AppState {
  projects: Record<string, Project>;
  activeProjectId: string;
  servers: Record<string, ServerWithName>;
  selectedServer: string;
  selectedMultipleServers: string[];
  isMultiSelectMode: boolean;
}

export type AgentServerInfo = {
  id: string;
  status: ConnectionStatus;
  config?: MCPServerConfig;
};

export type AppAction =
  | { type: "HYDRATE_STATE"; payload: AppState }
  | { type: "CLEAR_RUNTIME_STATE" }
  | { type: "UPSERT_SERVER"; name: string; server: ServerWithName }
  | {
      type: "CONNECT_REQUEST";
      name: string;
      config: MCPServerConfig;
      select?: boolean;
    }
  | {
      type: "CONNECT_SUCCESS";
      name: string;
      config: MCPServerConfig;
      tokens?: OauthTokens;
      useOAuth?: boolean;
      oauthTrace?: OAuthTrace;
    }
  | {
      type: "CONNECT_FAILURE";
      name: string;
      error: string;
      /**
       * Optional rich describe-error block. Forwarded onto
       * `ServerWithName.lastNormalizedError` so the ErrorCard renders
       * without re-classifying from `error`.
       */
      normalized?: NormalizedError;
      oauthTrace?: OAuthTrace;
    }
  | {
      type: "RECONNECT_REQUEST";
      name: string;
      config: MCPServerConfig;
      select?: boolean;
    }
  | {
      type: "DISCONNECT";
      name: string;
      error?: string;
      normalized?: NormalizedError;
    }
  | { type: "REMOVE_SERVER"; name: string }
  | { type: "SYNC_AGENT_STATUS"; servers: AgentServerInfo[] }
  | { type: "SELECT_SERVER"; name: string }
  | { type: "SET_MULTI_SELECTED"; names: string[] }
  | { type: "SET_MULTI_MODE"; enabled: boolean }
  | {
      type: "SET_INITIALIZATION_INFO";
      name: string;
      initInfo: InitializationInfo;
    }
  | {
      type: "SET_SERVER_OAUTH_TRACE";
      name: string;
      oauthTrace?: OAuthTrace;
    }
  | { type: "CREATE_PROJECT"; project: Project }
  | {
      type: "UPDATE_PROJECT";
      projectId: string;
      updates: Partial<Project>;
    }
  | {
      // Merge one section of `clientConfig` into the project's current
      // value, reading the current value from reducer state at the time
      // the action is processed. Necessary so concurrent connection +
      // host-context saves don't clobber each other locally — a full
      // `UPDATE_PROJECT` with a composed clientConfig captures the
      // sibling section at save-start, so a slow save can overwrite a
      // newer sibling. This action only touches the named slice.
      type: "UPDATE_PROJECT_CLIENT_CONFIG_SLICE";
      projectId: string;
      slice:
        | {
            kind: "connection";
            connectionDefaults: ProjectConnectionDefaults | undefined;
            clientCapabilities: Record<string, unknown>;
          }
        | {
            kind: "hostContext";
            hostContext: Record<string, unknown>;
          };
    }
  | { type: "DELETE_PROJECT"; projectId: string }
  | { type: "SWITCH_PROJECT"; projectId: string }
  | { type: "SET_DEFAULT_PROJECT"; projectId: string }
  | { type: "IMPORT_PROJECT"; project: Project }
  | { type: "DUPLICATE_PROJECT"; projectId: string; newName: string };

export function createLocalProjectId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }

  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createLocalDefaultProject(
  overrides: Partial<Project> = {}
): Project {
  const now = new Date();
  const id = overrides.id ?? createLocalProjectId();
  return {
    id,
    name: "Default",
    description: "Default project",
    servers: {},
    createdAt: now,
    updatedAt: now,
    isDefault: true,
    ...overrides,
  };
}

export function createInitialAppState(): AppState {
  const project = createLocalDefaultProject();
  return {
    projects: {
      [project.id]: project,
    },
    activeProjectId: project.id,
    servers: {},
    selectedServer: "none",
    selectedMultipleServers: [],
    isMultiSelectMode: false,
  };
}

export const initialAppState: AppState = createInitialAppState();
