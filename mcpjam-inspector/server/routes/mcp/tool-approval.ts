import { Hono } from "hono";
import type {
  PendingToolApproval,
  ToolApprovalResponse,
  ToolApprovalEvent,
} from "@/shared/tool-approval";
import { logger } from "../../utils/logger";

const toolApproval = new Hono();

// Track SSE subscribers
const toolApprovalSubscribers = new Set<{
  send: (event: unknown) => void;
  close: () => void;
}>();

// Track pending approval promises - resolve/reject functions keyed by approvalId
const pendingApprovals = new Map<
  string,
  {
    resolve: (response: ToolApprovalResponse) => void;
    reject: (error: Error) => void;
  }
>();

/**
 * Broadcast a tool approval event to all connected SSE clients
 */
function broadcastToolApproval(event: ToolApprovalEvent) {
  for (const sub of Array.from(toolApprovalSubscribers)) {
    try {
      sub.send(event);
    } catch {
      try {
        sub.close();
      } catch {}
      toolApprovalSubscribers.delete(sub);
    }
  }
}

/**
 * Request approval for a tool call from the frontend.
 * Returns a promise that resolves when the user responds.
 */
export async function requestToolApproval(
  approval: PendingToolApproval,
): Promise<ToolApprovalResponse> {
  return new Promise<ToolApprovalResponse>((resolve, reject) => {
    // Store the resolve/reject functions
    pendingApprovals.set(approval.approvalId, { resolve, reject });

    // Broadcast the approval request to connected clients
    broadcastToolApproval({
      type: "tool_approval_request",
      approvalId: approval.approvalId,
      toolCallId: approval.toolCallId,
      toolName: approval.toolName,
      toolDescription: approval.toolDescription,
      parameters: approval.parameters,
      serverName: approval.serverName,
      timestamp: approval.timestamp,
    });

    // Set a timeout to auto-reject after 5 minutes (user may have left)
    setTimeout(
      () => {
        if (pendingApprovals.has(approval.approvalId)) {
          pendingApprovals.delete(approval.approvalId);
          reject(new Error("Tool approval request timed out"));
        }
      },
      5 * 60 * 1000,
    );
  });
}

/**
 * Respond to a pending tool approval
 */
function respondToToolApproval(
  approvalId: string,
  response: ToolApprovalResponse,
): boolean {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) {
    return false;
  }

  pendingApprovals.delete(approvalId);
  pending.resolve(response);
  return true;
}

// SSE stream for tool approval events
toolApproval.get("/stream", async (c) => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: unknown) => {
        const payload = `data: ${JSON.stringify(event)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      };
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keep-alive\n\n`));
        } catch {}
      }, 25000);
      const close = () => {
        clearInterval(keepAlive);
        try {
          controller.close();
        } catch {}
      };

      // Initial retry suggestion
      controller.enqueue(encoder.encode(`retry: 1500\n\n`));

      const subscriber = { send, close };
      toolApprovalSubscribers.add(subscriber);

      // On client disconnect
      (c.req.raw as any).signal?.addEventListener?.("abort", () => {
        toolApprovalSubscribers.delete(subscriber);
        close();
      });
    },
  });

  return new Response(stream as any, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

// Endpoint for UI to respond to tool approval
toolApproval.post("/respond", async (c) => {
  try {
    const body = await c.req.json();
    const { approvalId, action, rememberForSession } = body as {
      approvalId: string;
      action: "approve" | "deny";
      rememberForSession?: boolean;
    };

    if (!approvalId || !action) {
      return c.json({ error: "Missing approvalId or action" }, 400);
    }

    if (action !== "approve" && action !== "deny") {
      return c.json(
        { error: "Invalid action, must be 'approve' or 'deny'" },
        400,
      );
    }

    const response: ToolApprovalResponse = {
      approvalId,
      action,
      rememberForSession,
    };

    const ok = respondToToolApproval(approvalId, response);
    if (!ok) {
      return c.json({ error: "Unknown or expired approvalId" }, 404);
    }

    // Notify completion
    broadcastToolApproval({
      type: "tool_approval_complete",
      approvalId,
      action,
    });

    return c.json({ ok: true });
  } catch (e: any) {
    logger.error("[tool-approval] Failed to respond", { error: e });
    return c.json({ error: e?.message || "Failed to respond" }, 400);
  }
});

export default toolApproval;
