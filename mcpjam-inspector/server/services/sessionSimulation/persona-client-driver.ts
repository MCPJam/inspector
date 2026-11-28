import {
  createStrictElicitationContentValidator,
  redactSensitiveValue,
  type ElicitationCallback,
  type MrtrInputCollector,
  type TaskInputHandlers,
} from "@mcpjam/sdk";
import {
  inputAnswerResult,
  inputAnswerSchema,
  type ClientActionReceipt,
} from "@mcpjam/sdk/contract";
import { z } from "zod";
import type { ToolSet } from "ai";
import { SYNTHETIC_SESSION_APPROVAL_DENIAL } from "@/shared/tool-approval";

type InputReply = ReturnType<typeof inputAnswerResult>;
export type PersonaClientRequest =
  | { kind: "question"; message: string; schema: unknown }
  | { kind: "approval"; tool: string; arguments: unknown };

type Question = {
  message: string;
  schema: unknown;
  mode?: "url" | "form";
  serverId?: string;
  toolName?: string;
};

const replyOutcome = {
  accept: "accepted",
  decline: "declined",
  cancel: "cancelled",
} as const;
const approvalSchema = z
  .object({ action: z.enum(["approve", "deny"]) })
  .strict();
const validateContent = createStrictElicitationContentValidator();
const maxPersonaRepliesPerSession = 20;
const maxReceiptCount = 64;
const replyTimeoutMs = 30_000;

function unwrapPersonaJson(response: string): string {
  const exactFence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i;
  const trimmed = response.trim();
  return exactFence.exec(trimmed)?.[1] ?? trimmed;
}

export type PersonaClientDriver = ReturnType<typeof createPersonaClientDriver>;

/** MCP tools with the host's ordinary approval switch use the simulated user.
 * Dynamic, native, and built-in approval policies keep their own gates. */
export function withPersonaToolApprovals(
  tools: ToolSet,
  selectedServerIds: readonly string[],
  driver: PersonaClientDriver,
): ToolSet {
  const selected = new Set(selectedServerIds);
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const { _serverId: serverId } = tool as {
        _serverId?: string;
      };
      const execute = tool.execute;
      if (
        !serverId ||
        !selected.has(serverId) ||
        tool.needsApproval !== true ||
        !execute
      )
        return [name, tool];
      return [
        name,
        {
          ...tool,
          needsApproval: false,
          execute: async (
            input: unknown,
            options: Parameters<typeof execute>[1],
          ) => {
            if (
              !(await driver.approve(
                name,
                serverId,
                options?.toolCallId,
                options?.abortSignal,
                input,
              ))
            ) {
              return {
                isError: true,
                content: [
                  { type: "text", text: SYNTHETIC_SESSION_APPROVAL_DENIAL },
                ],
              };
            }
            options?.abortSignal?.throwIfAborted();
            return execute(input, options);
          },
        },
      ];
    }),
  );
}

export function createPersonaClientDriver(options: {
  choose: (
    request: PersonaClientRequest,
    signal: AbortSignal,
  ) => Promise<string>;
  turnSignal: () => AbortSignal | undefined;
}) {
  let order = 0;
  let dispatched = 0;
  const seenApprovals = new Set<string>();
  const receipts: ClientActionReceipt[] = [];

  async function decide<T>(args: {
    request: PersonaClientRequest;
    serverId?: string;
    toolName?: string;
    invocationId?: string;
    signal?: AbortSignal;
    supported?: boolean;
    fallback: T;
    parse: (
      value: unknown,
    ) => { value: T; outcome: ClientActionReceipt["outcome"] } | undefined;
  }): Promise<T> {
    const turnSignal = options.turnSignal();
    if (!turnSignal || order >= maxReceiptCount) return args.fallback;
    const receipt: ClientActionReceipt = {
      id: crypto.randomUUID(),
      order: order++,
      actor: "persona",
      surface: "client",
      kind: args.request.kind,
      startedAt: Date.now(),
      elapsedMs: 0,
      outcome: "unavailable",
      ...(args.serverId && args.serverId.length <= 256
        ? { serverId: args.serverId }
        : {}),
      ...(args.toolName && args.toolName.length <= 256
        ? { toolName: args.toolName }
        : {}),
      ...(args.invocationId && args.invocationId.length <= 256
        ? { invocationId: args.invocationId }
        : {}),
    };
    const started = performance.now();
    try {
      if (args.supported === false) {
        receipt.outcome = "unsupported";
        return args.fallback;
      }
      if (dispatched >= maxPersonaRepliesPerSession) return args.fallback;
      const signal = AbortSignal.any([
        turnSignal,
        AbortSignal.timeout(replyTimeoutMs),
        ...(args.signal ? [args.signal] : []),
      ]);
      let onAbort: (() => void) | undefined;
      try {
        signal.throwIfAborted();
        dispatched++;
        const cancelled = new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
        });
        const response = await Promise.race([
          options.choose(args.request, signal),
          cancelled,
        ]);
        signal.throwIfAborted();
        receipt.outcome = "invalid";
        const parsed =
          response.length <= 5000
            ? args.parse(JSON.parse(unwrapPersonaJson(response)))
            : undefined;
        if (!parsed) return args.fallback;
        receipt.outcome = parsed.outcome;
        return parsed.value;
      } catch {
        if (signal.aborted) receipt.outcome = "expired";
        return args.fallback;
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
    } finally {
      receipt.elapsedMs = Math.max(0, Math.round(performance.now() - started));
      receipts.push(receipt);
    }
  }

  function answer(
    question: Question,
    signal?: AbortSignal,
  ): Promise<InputReply> {
    const { message, schema, serverId, toolName, mode } = question;
    return decide<InputReply>({
      request: { kind: "question", message, schema },
      serverId,
      toolName,
      signal,
      supported:
        mode !== "url" &&
        message.length <= 2000 &&
        JSON.stringify(schema ?? null).length <= 5600,
      fallback: { action: "decline" },
      parse(value) {
        const reply = inputAnswerSchema.safeParse(value);
        if (!reply.success) return;
        const { action, content } = inputAnswerResult(reply.data);
        if (
          action === "accept" &&
          !validateContent(schema, content ?? {}).valid
        )
          return;
        return {
          value: { action, ...(content && { content }) },
          outcome: replyOutcome[action],
        };
      },
    });
  }

  function fromParams(
    params: Record<string, unknown>,
    serverId: string,
    toolName?: string,
  ): Question {
    return {
      serverId,
      toolName,
      message: typeof params.message === "string" ? params.message : "",
      schema: params.requestedSchema,
      mode: params.mode === "url" ? "url" : "form",
    };
  }

  const elicitationCallback: ElicitationCallback = (request) => answer(request);
  const taskHandlers: TaskInputHandlers = {
    elicitation: (params, ctx) => answer(fromParams(params, ctx.serverId)),
  };

  return {
    elicitationCallback,
    taskHandlers,
    collectorFor(serverId: string): MrtrInputCollector {
      return async ({ state, inputRequests, signal }) => {
        const toolName =
          typeof state.originalParams.name === "string"
            ? state.originalParams.name
            : undefined;
        const responses: Record<string, InputReply> = Object.create(null);
        for (const [key, request] of Object.entries(inputRequests)) {
          const params = (request.params ?? {}) as Record<string, unknown>;
          responses[key] = await answer(
            fromParams(params, serverId, toolName),
            signal,
          );
        }
        return responses;
      };
    },
    approve(
      toolName: string,
      serverId: string,
      invocationId: string | undefined,
      signal?: AbortSignal,
      input: unknown = {},
    ): Promise<boolean> {
      if (
        !invocationId ||
        seenApprovals.has(invocationId) ||
        seenApprovals.size >= maxReceiptCount
      ) {
        return Promise.resolve(false);
      }
      seenApprovals.add(invocationId);
      const serialized = JSON.stringify(input);
      const inspectable = input !== null && typeof input === "object" && !Array.isArray(input) &&
        serialized !== undefined &&
        serialized.length <= 5000 &&
        serialized === JSON.stringify(redactSensitiveValue(input));
      return decide({
        request: { kind: "approval", tool: toolName, arguments: inspectable ? input : null },
        supported: inspectable,
        serverId,
        toolName,
        invocationId,
        signal,
        fallback: false,
        parse(value) {
          const decision = approvalSchema.safeParse(value);
          if (!decision.success) return;
          const approved = decision.data.action === "approve";
          return { value: approved, outcome: approved ? "approved" : "denied" };
        },
      });
    },
    takeReceipts() {
      return receipts.splice(0).sort((left, right) => left.order - right.order);
    },
  };
}
