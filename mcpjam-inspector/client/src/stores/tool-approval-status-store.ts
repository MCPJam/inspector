/**
 * Tool Approval Status Store
 *
 * Tracks the approval/denial status of tool calls using React primitives.
 * This provides a robust, type-safe way to detect tool approval states
 * without relying on fragile string matching in output data.
 */

import { create } from "zustand";

/**
 * Possible approval statuses for a tool call
 */
export type ToolApprovalStatus = "pending" | "approved" | "denied" | "expired";

/**
 * Detailed information about a tool's approval status
 */
export interface ToolApprovalStatusInfo {
  /** The tool call ID this status applies to */
  toolCallId: string;
  /** The approval ID from the server */
  approvalId: string;
  /** Current status */
  status: ToolApprovalStatus;
  /** Name of the tool */
  toolName: string;
  /** Timestamp when status was last updated */
  updatedAt: number;
  /** If remembered for session */
  rememberedForSession?: boolean;
}

interface ToolApprovalStatusState {
  /** Map of toolCallId -> approval status info */
  statuses: Map<string, ToolApprovalStatusInfo>;

  /**
   * Set of tool names that have been approved for auto-execution this session.
   * These are sent with each chat request so the server can skip approval prompts.
   */
  sessionApprovedTools: Set<string>;

  /**
   * Add a tool to the session-approved list using composite key (serverName:toolName)
   * to prevent cross-server auto-approval
   */
  addSessionApprovedTool: (serverName: string | undefined, toolName: string) => void;

  /**
   * Get all session-approved tool names as an array (for sending to server)
   */
  getSessionApprovedTools: () => string[];

  /**
   * Clear session-approved tools (e.g., when starting a new chat)
   */
  clearSessionApprovedTools: () => void;

  /**
   * Set a tool call as pending approval
   */
  setPending: (
    toolCallId: string,
    approvalId: string,
    toolName: string,
  ) => void;

  /**
   * Set a tool call as approved
   */
  setApproved: (
    toolCallId: string,
    approvalId: string,
    rememberedForSession?: boolean,
  ) => void;

  /**
   * Set a tool call as denied
   */
  setDenied: (toolCallId: string, approvalId: string) => void;

  /**
   * Update status by approvalId (used when server sends completion events)
   */
  updateByApprovalId: (
    approvalId: string,
    status: "approved" | "denied" | "expired",
    rememberedForSession?: boolean,
  ) => void;

  /**
   * Get status for a specific tool call
   */
  getStatus: (toolCallId: string) => ToolApprovalStatusInfo | undefined;

  /**
   * Check if a tool call was denied
   */
  isDenied: (toolCallId: string) => boolean;

  /**
   * Check if a tool call was approved
   */
  isApproved: (toolCallId: string) => boolean;

  /**
   * Check if a tool call is pending approval
   */
  isPending: (toolCallId: string) => boolean;

  /**
   * Check if a tool call expired (server timeout)
   */
  isExpired: (toolCallId: string) => boolean;

  /**
   * Remove status for a tool call
   */
  remove: (toolCallId: string) => void;

  /**
   * Clear all statuses (e.g., when starting a new chat session)
   */
  clear: () => void;
}

export const useToolApprovalStatusStore = create<ToolApprovalStatusState>(
  (set, get) => ({
    statuses: new Map(),
    sessionApprovedTools: new Set(),

    addSessionApprovedTool: (serverName, toolName) => {
      // Use composite key (serverName:toolName) to prevent cross-server auto-approval
      const approvalKey = serverName ? `${serverName}:${toolName}` : toolName;
      set((state) => {
        const sessionApprovedTools = new Set(state.sessionApprovedTools);
        sessionApprovedTools.add(approvalKey);
        return { sessionApprovedTools };
      });
    },

    getSessionApprovedTools: () => {
      return Array.from(get().sessionApprovedTools);
    },

    clearSessionApprovedTools: () => {
      set({ sessionApprovedTools: new Set() });
    },

    setPending: (toolCallId, approvalId, toolName) => {
      set((state) => {
        const statuses = new Map(state.statuses);
        statuses.set(toolCallId, {
          toolCallId,
          approvalId,
          toolName,
          status: "pending",
          updatedAt: Date.now(),
        });
        return { statuses };
      });
    },

    setApproved: (toolCallId, approvalId, rememberedForSession) => {
      set((state) => {
        const statuses = new Map(state.statuses);
        const existing = statuses.get(toolCallId);
        statuses.set(toolCallId, {
          toolCallId,
          approvalId,
          toolName: existing?.toolName ?? "unknown",
          status: "approved",
          updatedAt: Date.now(),
          rememberedForSession,
        });
        return { statuses };
      });
    },

    setDenied: (toolCallId, approvalId) => {
      set((state) => {
        const statuses = new Map(state.statuses);
        const existing = statuses.get(toolCallId);
        statuses.set(toolCallId, {
          toolCallId,
          approvalId,
          toolName: existing?.toolName ?? "unknown",
          status: "denied",
          updatedAt: Date.now(),
        });
        return { statuses };
      });
    },

    updateByApprovalId: (approvalId, status, rememberedForSession) => {
      set((state) => {
        const statuses = new Map(state.statuses);

        // Find the entry with matching approvalId
        for (const [toolCallId, info] of statuses.entries()) {
          if (info.approvalId === approvalId) {
            statuses.set(toolCallId, {
              ...info,
              status,
              updatedAt: Date.now(),
              // Only set rememberedForSession for approved status
              rememberedForSession:
                status === "approved" ? rememberedForSession : undefined,
            });
            break;
          }
        }

        return { statuses };
      });
    },

    getStatus: (toolCallId) => {
      return get().statuses.get(toolCallId);
    },

    isDenied: (toolCallId) => {
      return get().statuses.get(toolCallId)?.status === "denied";
    },

    isApproved: (toolCallId) => {
      return get().statuses.get(toolCallId)?.status === "approved";
    },

    isPending: (toolCallId) => {
      return get().statuses.get(toolCallId)?.status === "pending";
    },

    isExpired: (toolCallId) => {
      return get().statuses.get(toolCallId)?.status === "expired";
    },

    remove: (toolCallId) => {
      set((state) => {
        const statuses = new Map(state.statuses);
        statuses.delete(toolCallId);
        return { statuses };
      });
    },

    clear: () => {
      set({ statuses: new Map(), sessionApprovedTools: new Set() });
    },
  }),
);

/**
 * Hook to get the approval status for a specific tool call.
 * Returns undefined if no status is tracked for this tool call.
 */
export function useToolApprovalStatus(
  toolCallId: string | undefined,
): ToolApprovalStatusInfo | undefined {
  return useToolApprovalStatusStore((state) =>
    toolCallId ? state.statuses.get(toolCallId) : undefined,
  );
}

/**
 * Hook to check if a tool call was denied.
 * Returns false if no status is tracked or if the tool was approved.
 */
export function useIsToolDenied(toolCallId: string | undefined): boolean {
  return useToolApprovalStatusStore(
    (state) =>
      toolCallId !== undefined &&
      state.statuses.get(toolCallId)?.status === "denied",
  );
}

/**
 * Hook to check if a tool call was approved.
 */
export function useIsToolApproved(toolCallId: string | undefined): boolean {
  return useToolApprovalStatusStore(
    (state) =>
      toolCallId !== undefined &&
      state.statuses.get(toolCallId)?.status === "approved",
  );
}

/**
 * Hook to check if a tool call is pending approval.
 */
export function useIsToolPending(toolCallId: string | undefined): boolean {
  return useToolApprovalStatusStore(
    (state) =>
      toolCallId !== undefined &&
      state.statuses.get(toolCallId)?.status === "pending",
  );
}

/**
 * Hook to check if a tool call expired (server timeout).
 */
export function useIsToolExpired(toolCallId: string | undefined): boolean {
  return useToolApprovalStatusStore(
    (state) =>
      toolCallId !== undefined &&
      state.statuses.get(toolCallId)?.status === "expired",
  );
}
