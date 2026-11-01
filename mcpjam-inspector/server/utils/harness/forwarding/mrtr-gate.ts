import { isInputRequiredResult, type MrtrLegMiddleware } from "@mcpjam/sdk";
import type { ToolPolicySnapshot } from "@mcpjam/sdk/contract";
import {
  executeForwardedOperation,
  type GateApproval,
} from "./execution-gate.js";
import { forwardingExecutionContext } from "./execution-context.js";

/** Each SDK round has one send attempt, even if the SDK retries a read. */
export function createForwardingMrtrGate(args: {
  control: Parameters<typeof executeForwardedOperation>[0]["control"];
  approval: GateApproval;
  policy?: ToolPolicySnapshot;
  turnId: string;
  policyDigest?: string;
  expiresAt: number;
  signal: AbortSignal;
}): MrtrLegMiddleware {
  const attempted = new Set<string>();
  return async ({ operationId, round, request, signal, send }) => {
    const parent = forwardingExecutionContext.getStore();
    if (!parent) throw new Error("Missing original forwarding execution");
    const invocationKey = JSON.stringify([
      parent.executionId,
      operationId,
      round,
    ]);
    if (attempted.has(invocationKey))
      throw new Error("MCP continuation was already attempted");
    attempted.add(invocationKey);
    const active = signal
      ? AbortSignal.any([args.signal, signal])
      : args.signal;
    active.throwIfAborted();
    if (round === 0) return send();
    return executeForwardedOperation({
      control: args.control,
      approval: args.approval,
      signal: active,
      operation: {
        invocationKey,
        continuation: { executionId: parent.executionId, operationId, round },
        turnId: args.turnId,
        policyDigest: args.policyDigest,
        method: request.method,
        params: request.params,
        paramsPresent: true,
        expiresAt: args.expiresAt,
        policy: args.policy,
      },
      dispatch: async (settle) => {
        const result = await send();
        await settle({
          outcome: isInputRequiredResult(result)
            ? "input_required"
            : result &&
                typeof result === "object" &&
                "isError" in result &&
                result.isError === true
              ? "tool_error"
              : "success",
          resultJson: JSON.stringify(result),
        });
        return result;
      },
    });
  };
}
