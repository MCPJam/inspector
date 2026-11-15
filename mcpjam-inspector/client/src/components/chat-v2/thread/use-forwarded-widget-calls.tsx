import { useEffect, useRef, useState } from "react";
import {
  isCallToolResult,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { authFetch } from "@/lib/session-token";
import { parseSSEStream } from "@/lib/sse";
import type { RetainedResourceProof } from "@/shared/retained-app-resources";
import type { McpWidgetExecutionContext } from "@/shared/mcp-tool-origin-metadata";
import { ToolPart } from "./parts/tool-part";
import { toast } from "@/lib/toast";
import { HOSTED_HARNESS_INPUT_VERSION } from "@/shared/hosted-elicitation";

type Pending = {
  key: string;
  id: string;
  name: string;
  input: Record<string, unknown>;
  abort: AbortController;
};
const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approval"), id: z.string() }),
  z.object({ type: z.literal("result"), result: z.unknown() }),
  z.object({ type: z.literal("error"), error: z.string() }),
]);

/** Each widget action has its own approval; none of these cards enter model history. */
export function useForwardedWidgetCalls(
  chatSessionId?: string,
  enabled = true,
  parentExecutionId?: string,
) {
  const [pending, setPending] = useState<Pending[]>([]);
  const requests = useRef(new Set<AbortController>());
  useEffect(() => {
    const activeRequests = requests.current;
    setPending([]);
    return () => {
      for (const request of activeRequests) request.abort();
      activeRequests.clear();
    };
  }, [chatSessionId, enabled, parentExecutionId]);

  const answer = async (entry: Pending, approved: boolean) => {
    try {
      const response = await authFetch("/api/web/harness-forwarding/approval", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: entry.id, approved }),
        signal: entry.abort.signal,
      });
      if (!response.ok)
        entry.abort.abort(
          new Error("This App approval is no longer available."),
        );
    } catch (error) {
      entry.abort.abort(error);
    }
  };

  return {
    approvals: pending.map((entry) => (
      <ToolPart
        key={entry.id}
        chatSessionId={chatSessionId}
        part={{
          type: "dynamic-tool",
          toolName: entry.name,
          toolCallId: entry.key,
          state: "approval-requested",
          input: entry.input,
          approval: { id: entry.id },
        }}
        approvalId={entry.id}
        onApprove={() => {
          void answer(entry, true);
        }}
        onDeny={() => {
          void answer(entry, false);
        }}
      />
    )),
    call: async (
      context: McpWidgetExecutionContext | RetainedResourceProof,
      name: string,
      input: Record<string, unknown>,
    ): Promise<CallToolResult> => {
      if (!enabled) throw new Error("This App is no longer active.");
      const abort = new AbortController();
      const key = crypto.randomUUID();
      let cancelPending: (() => void) | undefined;
      requests.current.add(abort);
      try {
        const response = await authFetch("/api/web/harness-forwarding/widget", {
          method: "POST",
          headers: { "content-type": "application/json", "x-mcpjam-harness-input-version": String(HOSTED_HARNESS_INPUT_VERSION) },
          body: JSON.stringify({ context, toolName: name, arguments: input }),
          signal: abort.signal,
        });
        if (!response.ok || !response.body)
          throw new Error(
            "This App action is no longer available in the current chat.",
          );
        for await (const value of parseSSEStream(response.body.getReader())) {
          const parsed = eventSchema.safeParse(value);
          if (!parsed.success) continue;
          const event = parsed.data;
          if (event.type === "approval") {
            if (cancelPending)
              abort.signal.removeEventListener("abort", cancelPending);
            // A proxy can keep the response open after fetch aborts. Revoke
            // the pending approval explicitly, using its existing signed id.
            cancelPending = () => {
              void authFetch("/api/web/harness-forwarding/approval", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  id: event.id,
                  approved: false,
                  cancelled: true,
                }),
                keepalive: true,
              })
                .then((response) => {
                  if (!response.ok && response.status !== 409)
                    throw new Error(
                      "Could not confirm App cancellation. Check its status before trying again.",
                    );
                })
                .catch(() =>
                  toast.error(
                    "Could not confirm App cancellation. Check its status before trying again.",
                  ),
                );
            };
            abort.signal.addEventListener("abort", cancelPending, {
              once: true,
            });
            if (abort.signal.aborted) cancelPending();
            setPending((current) => [
              ...current.filter((entry) => entry.key !== key),
              { key, id: event.id, name, input, abort },
            ]);
          } else if (event.type === "error") throw new Error(event.error);
          else if (isCallToolResult(event.result)) return event.result;
          else throw new Error("The App returned an invalid tool result.");
        }
        throw new Error(
          "The App action ended without a confirmed result. Check its status before trying again.",
        );
      } finally {
        if (cancelPending)
          abort.signal.removeEventListener("abort", cancelPending);
        abort.abort();
        requests.current.delete(abort);
        setPending((current) => current.filter((entry) => entry.key !== key));
      }
    },
  };
}
