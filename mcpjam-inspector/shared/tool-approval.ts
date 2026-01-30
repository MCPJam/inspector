/**
 * Types for tool approval before execution feature.
 * Allows users to approve/deny tool calls before they execute.
 */

export interface PendingToolApproval {
  /** Unique identifier for this approval request */
  approvalId: string;
  /** The tool call ID from the AI model */
  toolCallId: string;
  /** Name of the tool being called */
  toolName: string;
  /** Optional description of the tool */
  toolDescription?: string;
  /** Parameters passed to the tool */
  parameters: Record<string, unknown>;
  /** Name of the server providing this tool */
  serverName?: string;
  /** Timestamp when this approval was requested */
  timestamp: string;
}

export interface ToolApprovalResponse {
  /** The approval ID this response is for */
  approvalId: string;
  /** User's action: approve or deny the tool call */
  action: "approve" | "deny";
  /** If true, auto-approve this tool for the rest of the session */
  rememberForSession?: boolean;
}

export interface ToolApprovalSettings {
  /** Whether tool approval is enabled */
  requireApproval: boolean;
  /** Set of tool names that have been auto-approved this session */
  approvedToolsThisSession: Set<string>;
}

/** Event types for SSE stream */
export type ToolApprovalEventType =
  | "tool_approval_request"
  | "tool_approval_complete";

export interface ToolApprovalRequestEvent {
  type: "tool_approval_request";
  approvalId: string;
  toolCallId: string;
  toolName: string;
  toolDescription?: string;
  parameters: Record<string, unknown>;
  serverName?: string;
  timestamp: string;
}

/** Completion event sent when user approves/denies a tool */
export interface ToolApprovalCompleteEventWithAction {
  type: "tool_approval_complete";
  approvalId: string;
  action: "approve" | "deny";
  rememberForSession?: boolean;
}

/** Completion event sent when server-side timeout expires */
export interface ToolApprovalCompleteEventWithStatus {
  type: "tool_approval_complete";
  approvalId: string;
  status: "expired";
}

export type ToolApprovalCompleteEvent =
  | ToolApprovalCompleteEventWithAction
  | ToolApprovalCompleteEventWithStatus;

export type ToolApprovalEvent =
  | ToolApprovalRequestEvent
  | ToolApprovalCompleteEvent;
