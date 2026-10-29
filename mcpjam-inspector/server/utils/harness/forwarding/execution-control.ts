import { z } from "zod";
import { getConvexHttpUrl } from "../../computers/control-plane-client.js";
import {
  requireServiceCredential,
  INSPECTOR_SERVICE_TOKEN_HEADER,
} from "../../../services/service-credential.js";

const commonOwner = {
  userId: z.string().min(1),
  serverId: z.string().min(1),
  connectionId: z.string().optional(),
};
export const forwardingOwnerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("chat"),
      ...commonOwner,
      harnessSessionId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("run"),
      ...commonOwner,
      sandboxRowId: z.string().min(1),
      owner: z.discriminatedUnion("kind", [
        z
          .object({ kind: z.literal("eval"), iterationId: z.string().min(1) })
          .strict(),
        z
          .object({ kind: z.literal("journey"), attemptId: z.string().min(1) })
          .strict(),
      ]),
    })
    .strict(),
]);
export type ForwardingOwner = z.infer<typeof forwardingOwnerSchema>;
export type ExecutionOutcome =
  | "success"
  | "tool_error"
  | "protocol_error"
  | "input_required"
  | "refused"
  | "denied"
  | "expired"
  | "cancelled"
  | "incomplete";
export type Settlement = {
  outcome: ExecutionOutcome;
  resultJson?: string;
  truncated?: boolean;
};
export type ExecutionIntent = {
  invocationKey: string;
  policyDigest?: string;
  turnId: string;
  rpcId: string | number;
  method: string;
  paramsJson: string;
  expiresAt: number;
};
const state = z.enum(["prepared", "dispatched", "settled"]);
const prepared = z.object({
  executionId: z.string(),
  state,
  replayed: z.boolean(),
  requireToolApproval: z.boolean(),
});
const payload = z
  .object({
    json: z.string().nullable(),
    url: z.string().nullable(),
    bytes: z.number(),
    truncated: z.boolean(),
  })
  .nullable();
const receipt = z.object({
  _id: z.string(),
  method: z.string(),
  turnId: z.string(),
  params: payload,
  authority: z.object({
    userId: z.string(),
    projectId: z.string(),
    sessionId: z.string(),
    serverId: z.string(),
    accountId: z.string(),
  }),
  state,
  outcome: z.string().optional(),
  result: payload,
  complete: z.boolean(),
  approval: z
    .object({
      nonceHash: z.string(),
      approvalId: z.string().optional(),
      expiresAt: z.number(),
      state: z.string(),
    })
    .optional(),
});
const approval = z.object({
  nonceHash: z.string(),
  expiresAt: z.number(),
  state: z.string(),
});
const claimed = z.object({ dispatch: z.boolean(), state });
const settled = z.object({ replayed: z.boolean(), adopted: z.boolean() });

export class ExecutionControlError extends Error {
  constructor(readonly code: string) {
    super(`Forwarding execution refused (${code}).`);
    this.name = "ExecutionControlError";
  }
}

/** One trusted service connection; neither credential is sent to the upstream MCP server. */
export function createExecutionControl(args: {
  owner: ForwardingOwner;
  token?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}) {
  const transport = args.fetch ?? fetch;
  const base = args.baseUrl ?? getConvexHttpUrl();
  if (!base) throw new ExecutionControlError("control_unavailable");
  const url = new URL("/internal/v1/harness-forwarding/executions", base);
  const credential = requireServiceCredential("Native MCP forwarding");
  async function post<T>(
    operation: object,
    schema: z.ZodType<T>,
    mode: "grant" | "owner" | "settle" = "grant",
  ): Promise<T> {
    if (mode === "grant" && !args.token)
      throw new ExecutionControlError("grant_unavailable");
    const body = JSON.stringify(
      mode === "settle"
        ? { operation }
        : {
            owner: args.owner,
            ...(mode === "grant" ? { token: args.token } : {}),
            operation,
          },
    );
    if (Buffer.byteLength(body) > 8 * 1024 * 1024)
      throw new ExecutionControlError("evidence_too_large");
    const response = await transport(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [INSPECTOR_SERVICE_TOKEN_HEADER]: credential,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new ExecutionControlError(`control_${response.status}`);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success)
      throw new ExecutionControlError("invalid_control_response");
    return parsed.data;
  }
  return {
    bindPolicy: (turnId: string, policyDigest: string) =>
      post(
        { kind: "bind_policy", turnId, policyDigest },
        z.object({ bound: z.literal(true) }),
        "owner",
      ),
    authorize: () =>
      post(
        { kind: "authorize" },
        z.object({
          userId: z.string(),
          externalId: z.string(),
          organizationId: z.string(),
          projectId: z.string(),
          expiresAt: z.number(),
          turnId: z.string().min(1),
          policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      ),
    turnApprovals: (turnId: string) =>
      post({ kind: "turn_approvals", turnId }, z.array(receipt), "owner"),
    approvalContext: (executionId: string) =>
      post({ kind: "approval_context", executionId }, receipt, "owner"),
    answerApproval: (
      executionId: string,
      nonceHash: string,
      decision: "approved" | "denied" | "cancelled",
    ) =>
      post(
        { kind: "answer_approval", executionId, nonceHash, decision },
        approval,
        "owner",
      ),
    prepare: (intent: ExecutionIntent) =>
      post({ kind: "prepare", ...intent }, prepared),
    read: (executionId: string) => post({ kind: "read", executionId }, receipt),
    requestApproval: (
      executionId: string,
      nonceHash: string,
      expiresAt: number,
      approvalId?: string,
    ) =>
      post(
        {
          kind: "request_approval",
          executionId,
          nonceHash,
          expiresAt,
          approvalId,
        },
        approval,
      ),
    decideApproval: (
      executionId: string,
      nonceHash: string,
      decision: "approved" | "denied" | "cancelled",
    ) =>
      post(
        { kind: "decide_approval", executionId, nonceHash, decision },
        approval,
      ),
    claim: (executionId: string, dispatchKey: string) =>
      post({ kind: "claim", executionId, dispatchKey }, claimed),
    settle: (
      executionId: string,
      dispatchKey: string | undefined,
      result: Settlement,
    ) =>
      post(
        {
          kind: "settle",
          executionId,
          ...(dispatchKey ? { dispatchKey } : {}),
          ...result,
        },
        settled,
        "settle",
      ),
  };
}
export type ExecutionControl = ReturnType<typeof createExecutionControl>;
