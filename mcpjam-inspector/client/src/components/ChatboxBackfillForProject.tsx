import { useChatboxBackfillForProject } from "@/hooks/useChatboxBackfillForProject";

/**
 * Effect-only mount that fires `chatboxes.ensureChatboxesForProject`
 * once per project per session. Sibling of `ActiveHostServerReconciler`
 * in the app shell — pre-populates the 1:1 host↔chatbox rows for any
 * pre-invariant hosts so the Chatboxes tab is instant once you arrive.
 */
export function ChatboxBackfillForProject({
  projectId,
  isAuthenticated,
}: {
  projectId: string | null;
  isAuthenticated: boolean;
}) {
  useChatboxBackfillForProject({ isAuthenticated, projectId });
  return null;
}
