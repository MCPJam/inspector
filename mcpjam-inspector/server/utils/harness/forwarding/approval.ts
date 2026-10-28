import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import {
  forwardingApprovalId,
  FORWARDING_TOOL_PREFIX,
} from "@/shared/forwarding-approval";
import {
  emitToolInput,
  emitToolApprovalRequest,
  emitToolOutput,
  type ChunkWriter,
} from "../../chat-stream-chunks.js";
import type { ExecutionControl, ForwardingOwner } from "./execution-control.js";
import type { GateApproval } from "./execution-gate.js";
import { logger } from "../../logger.js";
const inputSchema = z.object({
  present: z.boolean(),
  value: z.unknown().optional(),
});
export async function readExecutionInput(
  receipt: Awaited<ReturnType<ExecutionControl["read"]>>,
) {
  const payload = receipt.params;
  let raw = payload?.json;
  if (!raw && payload?.url) {
    const response = await fetch(payload.url, {
      signal: AbortSignal.timeout(10_000),
    });
    if (
      !response.ok ||
      Number(response.headers.get("content-length") ?? 0) > 1024 * 1024
    )
      throw new Error("Approval input is unavailable.");
    raw = await response.text();
  }
  if (!raw || Buffer.byteLength(raw) > 1024 * 1024)
    throw new Error("Approval input is unavailable.");
  return inputSchema.parse(JSON.parse(raw));
}
export function forwardingApproval(
  control: ExecutionControl,
  owner: ForwardingOwner,
  projectId: string,
): GateApproval {
  return {
    binding: {
      subject: `forwarding:${owner.userId}`,
      projectId,
      chatSessionId:
        owner.kind === "chat" ? owner.harnessSessionId : owner.sandboxRowId,
    },
    ask: async ({ executionId, approvalId, signal }) => {
      while (!signal.aborted) {
        const row = await control.read(executionId);
        const state = row.approval?.state;
        if (state === "approved" || state === "denied" || state === "cancelled")
          return { approvalId, decision: state };
        if (state === "expired") return { approvalId, decision: "cancelled" };
        await delay(300, undefined, { signal });
      }
      signal.throwIfAborted();
      throw new Error("Approval was cancelled.");
    },
  };
}

/** Present the persisted gate record, never an argument-based join to a native call. */
export function startForwardingApprovalPresentation(args: {
  control: ExecutionControl;
  owner: ForwardingOwner;
  turnId: string;
  writer: ChunkWriter;
}): () => Promise<void> {
  const abort = new AbortController();
  const shown = new Set<string>();
  const completed = new Set<string>();
  let reported = false;
  const poll = async (final = false) => {
    try {
      const rows = await args.control.turnApprovals(args.turnId);
      for (const row of rows) {
        if ((!final && abort.signal.aborted) || !row.approval?.approvalId)
          continue;
        const toolCallId = FORWARDING_TOOL_PREFIX + row._id;
        if (!shown.has(row._id)) {
          const input = await readExecutionInput(row);
          const params =
            input.value && typeof input.value === "object" ? input.value : {};
          const toolName =
            "name" in params && typeof params.name === "string"
              ? params.name
              : "MCP tool";
          emitToolInput(args.writer, {
            toolCallId,
            toolName: `Approve ${toolName}`,
            input: {
              server: row.authority.serverId,
              account: row.authority.accountId,
              arguments: "arguments" in params ? params.arguments : {},
            },
          });
          emitToolApprovalRequest(args.writer, {
            toolCallId,
            approvalId: forwardingApprovalId(
              row._id,
              args.owner,
              row.approval.approvalId,
            ),
          });
          shown.add(row._id);
        }
        if (row.state === "settled" && !completed.has(row._id)) {
          emitToolOutput(args.writer, {
            toolCallId,
            output: { authorization: row.outcome },
          });
          completed.add(row._id);
        }
      }
    } catch (error) {
      if (!abort.signal.aborted && !reported) {
        logger.warn("forwarding.approval.presentation_unavailable", {
          reason: error instanceof Error ? error.name : "unknown",
        });
        reported = true;
      }
    }
  };
  const run = async () => {
    while (!abort.signal.aborted) {
      await poll();
      try {
        await delay(500, undefined, { signal: abort.signal });
      } catch {
        /* Stopping this turn cancels only its presentation poll. */
      }
    }
  };
  const running = run();
  return async () => {
    abort.abort();
    await running;
    await poll(true);
  };
}
