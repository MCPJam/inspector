import type {
  HarnessV1,
  HarnessV1ContinueTurnOptions,
  HarnessV1PromptControl,
  HarnessV1PromptTurnOptions,
} from "@ai-sdk/harness";
import { coerceToolInput } from "./tool-input.js";

/** The call a native request is about, as the runtime's `tool-call` named it. */
export interface NativeRequestCall {
  name: string;
  /** The runtime's own name for a built-in, when it differs (`Bash`). */
  nativeName?: string;
  input: unknown;
}

/** MCPJam's answer to a native request: run the call, refuse it with a
 *  reason the model reads, or leave it to the person in the conversation. */
export type NativeRequestDecision =
  { kind: "approve" } | { kind: "deny"; reason: string } | { kind: "ask" };

type Answer = Exclude<NativeRequestDecision, { kind: "ask" }>;

/**
 * Answer a runtime's native requests in MCPJam. `decide` sees the call each
 * request is about, or nothing when the runtime named none. A request it
 * leaves to a person, and one a continuation already carries the person's
 * decision for, reaches the caller unchanged. Framework host-tool gates are
 * not native requests and stay intact.
 */
export function withNativeRequestDecisions<T extends HarnessV1>(
  harness: T,
  decide: (call: NativeRequestCall | undefined) => NativeRequestDecision,
  settings: {
    pendingApprovalIds?: ReadonlySet<string>;
    onAnswer?: (approvalId: string, answer: Answer) => void;
  } = {},
): T {
  const pendingApprovalIds = settings.pendingApprovalIds ?? new Set<string>();
  return new Proxy(harness, {
    get(target, key) {
      if (key !== "doStart") {
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (startOptions: Parameters<T["doStart"]>[0]) => {
        const session = await target.doStart(startOptions);
        return new Proxy(session, {
          get(sessionTarget, method) {
            if (method !== "doPromptTurn" && method !== "doContinueTurn") {
              const value = Reflect.get(sessionTarget, method);
              return typeof value === "function"
                ? value.bind(sessionTarget)
                : value;
            }
            return async (
              options:
                HarnessV1PromptTurnOptions | HarnessV1ContinueTurnOptions,
            ) => {
              const seen = new Set<string>();
              const toolCalls = new Map<string, NativeRequestCall>();
              const queued: Array<{ approvalId: string; answer: Answer }> = [];
              let control: HarnessV1PromptControl | undefined;
              let pending = Promise.resolve();
              let fail!: (error: unknown) => void;
              const failure = new Promise<never>((_, reject) => {
                fail = reject;
              });
              // Startup may emit before the caller can attach to done.
              void failure.catch(() => {});
              const submit = (approvalId: string, answer: Answer) => {
                pending = pending.then(async () => {
                  if (!control?.submitToolApproval)
                    throw new Error(
                      "Runtime cannot answer its native approval request",
                    );
                  await control.submitToolApproval({
                    approvalId,
                    approved: answer.kind === "approve",
                    ...(answer.kind === "deny"
                      ? { reason: answer.reason }
                      : {}),
                  });
                  settings.onAnswer?.(approvalId, answer);
                });
                void pending.catch(fail);
              };
              const emit: typeof options.emit = (part) => {
                if (part.type === "tool-call") {
                  if (toolCalls.size >= 1024) toolCalls.delete(toolCalls.keys().next().value!);
                  toolCalls.set(part.toolCallId, {
                    name: part.toolName,
                    ...(part.nativeName ? { nativeName: part.nativeName } : {}),
                    input: coerceToolInput(part.input),
                  });
                }
                if (part.type !== "tool-approval-request") {
                  options.emit(part);
                  return;
                }
                const decision = pendingApprovalIds.has(part.approvalId)
                  ? ({ kind: "ask" } as const)
                  : decide(toolCalls.get(part.toolCallId));
                if (decision.kind === "ask") {
                  options.emit(part);
                  return;
                }
                if (seen.has(part.approvalId)) return;
                seen.add(part.approvalId);
                if (control) submit(part.approvalId, decision);
                else
                  queued.push({
                    approvalId: part.approvalId,
                    answer: decision,
                  });
              };
              control = await (method === "doPromptTurn"
                ? sessionTarget.doPromptTurn({
                    ...options,
                    emit,
                  } as HarnessV1PromptTurnOptions)
                : sessionTarget.doContinueTurn({ ...options, emit }));
              for (const { approvalId, answer } of queued)
                submit(approvalId, answer);
              return {
                ...control,
                submitToolResult: control.submitToolResult?.bind(control),
                submitToolApproval: control.submitToolApproval?.bind(control),
                submitUserMessage: control.submitUserMessage?.bind(control),
                done: Promise.race([
                  Promise.resolve(control.done).then(() => pending),
                  failure,
                ]),
              };
            };
          },
        });
      };
    },
  });
}

/** Pre-approve native requests only. Framework host-tool gates remain intact. */
export function withAutoApprovedNativeRequests<T extends HarnessV1>(
  harness: T,
  onApproval?: (approvalId: string) => void,
  pendingApprovalIds: ReadonlySet<string> = new Set(),
  /** Sees the call's input too: some runtimes name the server only there. */
  shouldApprove?: (toolName: string | undefined, input: unknown) => boolean,
): T {
  return withNativeRequestDecisions(
    harness,
    (call) =>
      !shouldApprove || shouldApprove(call?.name, call?.input)
        ? { kind: "approve" }
        : { kind: "ask" },
    {
      pendingApprovalIds,
      onAnswer: (approvalId) => onApproval?.(approvalId),
    },
  );
}
