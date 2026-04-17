import type { ServerDoctorResult } from "./server-doctor.js";

export type ConnectPhase = "authorize" | "probe" | "connect" | "post_connect";

export type ConnectStatus =
  | "connected"
  | "partial"
  | "oauth_required"
  | "failed";

export type ConnectIssueCode =
  | "INVALID_CONFIG"
  | "OAUTH_REQUIRED"
  | "AUTH_ERROR"
  | "TIMEOUT"
  | "SERVER_UNREACHABLE"
  | "STDIO_START_FAILED"
  | "TRANSPORT_NEGOTIATION_FAILED"
  | "POST_CONNECT_VALIDATION_FAILED"
  | "INTERNAL_ERROR";

export interface ConnectIssue {
  code: ConnectIssueCode;
  phase: ConnectPhase;
  message: string;
  statusCode?: number;
  retryable?: boolean;
}

export interface ConnectContext {
  requestedClientCapabilities: Record<string, unknown> | null;
  oauth?: {
    protocolVersion: "2025-06-18" | "2025-11-25";
    registrationStrategy: "dcr" | "preregistered" | "cimd";
    usedCustomClientCredentials: boolean;
    useRegistryOAuthProxy: boolean;
  };
}

export interface ConnectReport {
  success: boolean;
  status: ConnectStatus;
  target: string;
  initInfo: unknown | null;
  issue?: ConnectIssue;
  diagnostics?: ServerDoctorResult;
  context: ConnectContext;
}
