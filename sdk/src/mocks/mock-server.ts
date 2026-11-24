import { Server } from "@modelcontextprotocol/server";
import type {
  CallToolResult,
  InputRequiredResult,
  Result,
} from "@modelcontextprotocol/server";

/** A task's handle, to go out as the answer to a `tools/call` in place of a tool result. */
export interface TaskCreated {
  taskCreated: Result;
}

export function isTaskCreated(value: unknown): value is TaskCreated {
  return typeof value === "object" && value !== null && "taskCreated" in value;
}

export type CallAnswer = CallToolResult | InputRequiredResult | TaskCreated;

/**
 * The server SDK has no task runtime: its `tools/call` handler may return only
 * a tool result or an `input_required` result, and checks both. A task's
 * handle is neither (2025-11-25: `{ task }`; 2026-07-28: `resultType: "task"`),
 * so the call handler hands it here and the wrapper puts it on the wire in
 * place of the placeholder the typed handler had to return.
 */
export class MockServer extends Server {
  /** By JSON-RPC request id, which is unique among the requests one server instance is serving. */
  private held = new Map<string | number, Result>();

  holdTask(requestId: string | number, handle: Result): void {
    this.held.set(requestId, handle);
  }

  protected override _wrapHandler(
    method: string,
    handler: Parameters<Server["_wrapHandler"]>[1]
  ): ReturnType<Server["_wrapHandler"]> {
    const wrapped = super._wrapHandler(method, handler);
    if (method !== "tools/call") return wrapped;
    return async (request, ctx) => {
      const result = await wrapped(request, ctx);
      const handle = this.held.get(ctx.mcpReq.id);
      this.held.delete(ctx.mcpReq.id);
      return handle ?? result;
    };
  }
}
