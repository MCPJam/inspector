import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { isToolUIPart, type UIMessage } from "ai";
import { useConvex } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { Harness } from "@mcpjam/sdk/host-config/internal";
import { toast } from "sonner";
import { reportCaught } from "@/lib/error-reporting";

type Owner = { projectId: string; harnessId: Harness; chatSessionId: string };
const cancelledQuery = makeFunctionReference<"query", Owner, string[]>(
  "harnessApprovalCancellation:cancelledApprovals",
);
const cancelMutation = makeFunctionReference<
  "mutation", Owner & { approvalIds: string[] }, "cancelled" | "already-continuing"
>("harnessApprovalCancellation:cancelPendingApproval");

export function pendingHarnessApprovalIds(messages: UIMessage[]): string[] {
  return messages.flatMap((message) => message.parts.flatMap((part) =>
    isToolUIPart(part) && part.state === "approval-requested" ? [part.approval.id] : [],
  ));
}

export function closeCancelledHarnessApprovals(messages: UIMessage[], ids: string[]): UIMessage[] {
  return messages.map((message) => ({ ...message, parts: message.parts.map((part) =>
    isToolUIPart(part) && part.state === "approval-requested" && ids.includes(part.approval.id)
      ? { ...part, state: "output-denied" as const,
          approval: { ...part.approval, approved: false as const, reason: "Stopped by user." } }
      : part,
  ) }));
}

export function useHarnessApprovalStop({ owner, messages, setMessages }: {
  owner: Owner | null;
  messages: UIMessage[];
  setMessages: Dispatch<SetStateAction<UIMessage[]>>;
}) {
  const convex = useConvex();
  const [stopping, setStopping] = useState(false);
  const ownerKey = JSON.stringify(owner);
  const currentOwner = useRef(ownerKey);
  useLayoutEffect(() => { currentOwner.current = ownerKey; }, [ownerKey]);
  const inFlight = useRef(false);
  const approvalIds = useMemo(() => owner ? pendingHarnessApprovalIds(messages) : [], [messages, ownerKey]);
  const pendingKey = JSON.stringify(approvalIds);

  // Rehydrating a saved transcript must not restore an ended approval card.
  useEffect(() => {
    if (!owner || !approvalIds.length) return;
    let active = true;
    void convex.query(cancelledQuery, owner).then((ids) => {
      if (active && ids?.some((id) => approvalIds.includes(id))) {
        setMessages((current) => closeCancelledHarnessApprovals(current, ids));
      }
    }).catch((error: unknown) => {
      reportCaught(error, { source: "harness_cancelled_approvals" });
    });
    return () => { active = false; };
  }, [convex, ownerKey, pendingKey, setMessages]);

  const stopApproval = useCallback(async () => {
    if (!owner || !approvalIds.length || inFlight.current) return;
    inFlight.current = true;
    setStopping(true);
    try {
      const result = await convex.mutation(cancelMutation, { ...owner, approvalIds });
      if (currentOwner.current !== ownerKey) return;
      if (result !== "cancelled") {
        toast.error("This action has already been answered. Refresh the conversation.");
        return;
      }
      setMessages((current) => closeCancelledHarnessApprovals(current, approvalIds));
    } catch (error) {
      reportCaught(error, { source: "harness_stop_approval" });
      toast.error("Could not stop this action. Try again.");
    } finally {
      inFlight.current = false;
      setStopping(false);
    }
  }, [convex, ownerKey, pendingKey, setMessages]);

  return { canStopApproval: Boolean(owner && approvalIds.length), stopping, stopApproval };
}
