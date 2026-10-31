import { randomUUID } from "node:crypto";
import {
  decideToolPolicyFromSnapshot,
  type ToolPolicySnapshot,
} from "@mcpjam/sdk/contract";
import {
  canonicalJson,
  mintToolApprovalId,
  toolApprovalClaimKey,
  verifyToolApprovalId,
  TOOL_APPROVAL_TOKEN_MAX_AGE_MS,
  type ToolApprovalBinding,
} from "../../tool-approval-token.js";
import {
  ExecutionControlError,
  type ExecutionControl,
  type ExecutionIntent,
  type Settlement,
} from "./execution-control.js";

export type GateOperation = Omit<ExecutionIntent, "paramsJson"> & {
  params?: unknown;
  paramsPresent: boolean;
  policy?: ToolPolicySnapshot;
};
export type ApprovalAnswer = {
  approvalId: string;
  decision: "approved" | "denied" | "cancelled";
};
export type GateApproval = {
  binding: ToolApprovalBinding;
  ask: (request: {
    executionId: string;
    approvalId: string;
    toolName: string;
    input: unknown;
    expiresAt: number;
    signal: AbortSignal;
  }) => Promise<ApprovalAnswer>;
};

export function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    // Observe an already-created ask promise even when cancellation won first.
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

/** The only path from an authenticated native operation to upstream dispatch. */
export async function executeForwardedOperation<T>(args: {
  control: Pick<
    ExecutionControl,
    | "prepare"
    | "read"
    | "requestApproval"
    | "decideApproval"
    | "claim"
    | "settle"
  >;
  operation: GateOperation;
  approval?: GateApproval;
  signal?: AbortSignal;
  replay?: (
    receipt: Awaited<ReturnType<ExecutionControl["read"]>>,
  ) => Promise<T>;
  dispatch: (
    settle: (result: Settlement) => Promise<void>,
    snapshot: Readonly<GateOperation>,
  ) => Promise<T>;
}): Promise<T> {
  const { control, operation } = args;
  args.signal?.throwIfAborted();
  const { params, paramsPresent, ...identity } = operation;
  const { policy: sourcePolicy, ...intent } = identity;
  const policy = sourcePolicy && structuredClone(sourcePolicy);
  const paramsJson = canonicalJson({
    present: paramsPresent,
    ...(paramsPresent ? { value: params } : {}),
  });
  const input: { present: boolean; value?: unknown } = JSON.parse(paramsJson);
  const snapshot: GateOperation = {
    ...intent,
    paramsPresent,
    params: input.value,
    policy,
  };
  const prepared = await control.prepare({
    ...intent,
    paramsJson,
  });
  // A native request gets a fresh invocation key unless its adapter proves a
  // trustworthy attempt identity. Even a lost dispatch acknowledgement never
  // gives the caller another upstream send.
  if (prepared.state === "settled" && args.replay)
    return args.replay(await control.read(prepared.executionId));
  if (prepared.state !== "prepared" || prepared.replayed)
    throw new ExecutionControlError("execution_already_started");
  const requireNotAborted = async () => {
    if (args.signal?.aborted) {
      await control.settle(prepared.executionId, undefined, {
        outcome: "cancelled",
      });
      args.signal.throwIfAborted();
    }
  };
  await requireNotAborted();
  const frozenParams = input.value;
  const toolName =
    frozenParams &&
    typeof frozenParams === "object" &&
    "name" in frozenParams &&
    typeof frozenParams.name === "string"
      ? frozenParams.name
      : "";
  if (intent.method === "tools/call" && policy) {
    const decision = decideToolPolicyFromSnapshot({
      snapshot: policy,
      toolName,
    });
    if (!decision.allowed) {
      await control.settle(prepared.executionId, undefined, {
        outcome: "refused",
      });
      throw new ExecutionControlError("blocked_by_policy");
    }
  }
  if (intent.method === "tools/call" && prepared.requireToolApproval) {
    if (!args.approval) {
      await control.settle(prepared.executionId, undefined, {
        outcome: "refused",
      });
      throw new ExecutionControlError("approval_unavailable");
    }
    const call = { toolCallId: prepared.executionId, toolName, input };
    const approvalExpiresAt = Math.min(
      intent.expiresAt,
      Date.now() + TOOL_APPROVAL_TOKEN_MAX_AGE_MS,
    );
    const approvalId = mintToolApprovalId({
      call,
      binding: args.approval.binding,
    });
    const nonceHash = approvalId && toolApprovalClaimKey(approvalId);
    if (!approvalId || !nonceHash) {
      await control.settle(prepared.executionId, undefined, {
        outcome: "refused",
      });
      throw new ExecutionControlError("approval_unavailable");
    }
    await control.requestApproval(
      prepared.executionId,
      nonceHash,
      approvalExpiresAt,
      approvalId,
    );
    let answer: ApprovalAnswer;
    try {
      const signal = AbortSignal.any([
        ...(args.signal ? [args.signal] : []),
        AbortSignal.timeout(Math.max(0, approvalExpiresAt - Date.now())),
      ]);
      answer = await withAbort(
        args.approval.ask({
          executionId: prepared.executionId,
          approvalId,
          toolName,
          input,
          expiresAt: approvalExpiresAt,
          signal,
        }),
        signal,
      );
    } catch (error) {
      await control.decideApproval(
        prepared.executionId,
        nonceHash,
        "cancelled",
      );
      throw error;
    }
    if (
      answer.approvalId !== approvalId ||
      !verifyToolApprovalId({
        approvalId: answer.approvalId,
        call,
        binding: args.approval.binding,
      }).ok
    ) {
      await control.decideApproval(prepared.executionId, nonceHash, "denied");
      throw new ExecutionControlError("approval_unverified");
    }
    const decided = await control.decideApproval(
      prepared.executionId,
      nonceHash,
      answer.decision,
    );
    if (decided.state !== "approved")
      throw new ExecutionControlError("approval_not_granted");
  }
  await requireNotAborted();
  const dispatchKey = randomUUID();
  let claim: Awaited<ReturnType<ExecutionControl["claim"]>>;
  try {
    claim = await control.claim(prepared.executionId, dispatchKey);
  } catch (error) {
    try {
      await control.settle(prepared.executionId, dispatchKey, {
        outcome: "incomplete",
      });
    } catch (settlementError) {
      // A claim that never committed cannot settle. Neither failure permits a send.
      throw new AggregateError(
        [error, settlementError],
        "Dispatch and evidence could not be confirmed.",
      );
    }
    throw error;
  }
  if (!claim.dispatch) throw new ExecutionControlError("dispatch_unconfirmed");
  let settlement: Promise<void> | undefined;
  const settle = (result: Settlement): Promise<void> =>
    (settlement ??= control
      .settle(prepared.executionId, dispatchKey, result)
      .then(() => undefined));
  try {
    args.signal?.throwIfAborted();
    return await args.dispatch(settle, snapshot);
  } catch (error) {
    await settle({ outcome: "incomplete" });
    throw error;
  }
}
