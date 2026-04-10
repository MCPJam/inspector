import type {
  HttpHistoryEntry,
  InfoLogEntry,
} from "@/lib/oauth/state-machines/types";
import {
  DEFAULT_NEGATIVE_TEST_MODE,
  type NegativeTestMode,
} from "@/shared/xaa.js";

export type XAAFlowStep =
  | "idle"
  | "discover_resource_metadata"
  | "received_resource_metadata"
  | "discover_authz_metadata"
  | "received_authz_metadata"
  | "user_authentication"
  | "received_identity_assertion"
  | "token_exchange_request"
  | "received_id_jag"
  | "inspect_id_jag"
  | "jwt_bearer_request"
  | "received_access_token"
  | "authenticated_mcp_request"
  | "complete";

export interface XAAJWTInspectionIssue {
  section: "header" | "payload" | "signature";
  field: string;
  label: string;
  expected: string;
  actual: string;
}

export interface XAADecodedJwt {
  header: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
  signature: string;
  issues: XAAJWTInspectionIssue[];
}

export interface XAAFlowState {
  isBusy: boolean;
  currentStep: XAAFlowStep;
  serverUrl?: string;
  resourceUrl?: string;
  resourceMetadataUrl?: string;
  resourceMetadata?: {
    resource?: string;
    authorization_servers?: string[];
    bearer_methods_supported?: string[];
    scopes_supported?: string[];
  };
  authzServerIssuer?: string;
  authzMetadata?: {
    issuer: string;
    token_endpoint: string;
    grant_types_supported?: string[];
    response_types_supported?: string[];
    scopes_supported?: string[];
    token_endpoint_auth_methods_supported?: string[];
  };
  tokenEndpoint?: string;
  negativeTestMode: NegativeTestMode;
  userId?: string;
  email?: string;
  clientId?: string;
  scope?: string;
  identityAssertion?: string;
  idJag?: string;
  idJagDecoded?: XAADecodedJwt | null;
  accessToken?: string;
  tokenType?: string;
  expiresIn?: number;
  lastRequest?: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: any;
  };
  lastResponse?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: any;
  };
  httpHistory?: Array<HttpHistoryEntry>;
  infoLogs?: Array<InfoLogEntry>;
  error?: string;
}

export interface XAARequestResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: any;
  ok: boolean;
}

export interface XAARequestExecutor {
  internalRequest: (
    path: string,
    init?: RequestInit,
  ) => Promise<XAARequestResult>;
  externalRequest: (
    url: string,
    init?: RequestInit,
  ) => Promise<XAARequestResult>;
}

export interface BaseXAAStateMachineConfig {
  state: XAAFlowState;
  getState?: () => XAAFlowState;
  updateState: (updates: Partial<XAAFlowState>) => void;
  serverUrl: string;
  issuerBaseUrl: string;
  requestExecutor: XAARequestExecutor;
  scheduleAutoAdvance?: (next: () => void) => void;
  negativeTestMode?: NegativeTestMode;
  userId?: string;
  email?: string;
  clientId?: string;
  scope?: string;
  authzServerIssuer?: string;
}

export interface XAAStateMachine {
  state: XAAFlowState;
  updateState: (updates: Partial<XAAFlowState>) => void;
  proceedToNextStep: () => Promise<void>;
  resetFlow: () => void;
}

export const EMPTY_XAA_FLOW_STATE: XAAFlowState = {
  isBusy: false,
  currentStep: "idle",
  serverUrl: undefined,
  resourceUrl: undefined,
  resourceMetadataUrl: undefined,
  resourceMetadata: undefined,
  authzServerIssuer: undefined,
  authzMetadata: undefined,
  tokenEndpoint: undefined,
  negativeTestMode: DEFAULT_NEGATIVE_TEST_MODE,
  userId: undefined,
  email: undefined,
  clientId: undefined,
  scope: undefined,
  identityAssertion: undefined,
  idJag: undefined,
  idJagDecoded: undefined,
  accessToken: undefined,
  tokenType: undefined,
  expiresIn: undefined,
  lastRequest: undefined,
  lastResponse: undefined,
  httpHistory: [],
  infoLogs: [],
  error: undefined,
};

export function createInitialXAAFlowState(
  overrides: Partial<XAAFlowState> = {},
): XAAFlowState {
  return {
    ...EMPTY_XAA_FLOW_STATE,
    ...overrides,
    negativeTestMode:
      overrides.negativeTestMode ?? DEFAULT_NEGATIVE_TEST_MODE,
    httpHistory: overrides.httpHistory ?? [],
    infoLogs: overrides.infoLogs ?? [],
  };
}
