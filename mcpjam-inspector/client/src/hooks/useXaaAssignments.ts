import { useMutation } from "convex/react";
import { useCallback, useState } from "react";
import type { XaaScopeMode } from "@/lib/xaa/types";

export interface XaaAssignmentInput {
  connectionId: string;
  testIdentityId: string;
  scopeMode: XaaScopeMode;
  /** Required iff scopeMode === "selected" (⊆ connection-effective scopes). */
  selectedScopes?: string[];
}

export interface UseXaaAssignmentsResult {
  error: string | null;
  /** Unique per (connection, identity) — re-upserting updates in place. */
  upsertAssignment: (input: XaaAssignmentInput) => Promise<{ id: string }>;
  removeAssignment: (assignmentId: string) => Promise<void>;
}

/**
 * Assignment mutations for the managed test IdP: which org People may access
 * a connection, and with what scope subset. Assignment rows arrive joined on
 * `useXaaManagedConnections().connections[].assignments` — this hook only
 * writes.
 */
export function useXaaAssignments(): UseXaaAssignmentsResult {
  // Cast the new function names `as any` until backend `_generated` types
  // regenerate after the managed-IdP data layer deploys.
  const upsertMutation = useMutation(
    "xaaManagedConnections:upsertAssignment" as any,
  );
  const removeMutation = useMutation(
    "xaaManagedConnections:removeAssignment" as any,
  );

  const [error, setError] = useState<string | null>(null);

  const upsertAssignment = useCallback(
    async (input: XaaAssignmentInput): Promise<{ id: string }> => {
      setError(null);
      try {
        const result = await upsertMutation(input as any);
        return result as { id: string };
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Couldn't save this assignment",
        );
        throw err;
      }
    },
    [upsertMutation],
  );

  const removeAssignment = useCallback(
    async (assignmentId: string): Promise<void> => {
      setError(null);
      try {
        await removeMutation({ assignmentId } as any);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Couldn't remove this assignment",
        );
        throw err;
      }
    },
    [removeMutation],
  );

  return { error, upsertAssignment, removeAssignment };
}
