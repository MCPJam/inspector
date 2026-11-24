import type {
  HarnessV1,
  HarnessV1ContinueTurnOptions,
  HarnessV1PromptControl,
  HarnessV1PromptTurnOptions,
} from "@ai-sdk/harness";
import { SYNTHETIC_SESSION_APPROVAL_DENIAL } from "@/shared/tool-approval";
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

export const APPROVE_NATIVE_REQUEST: Answer = { kind: "approve" };

/** MCPJam's answer when nobody can answer: the engine's own denial, so the
 *  model reads the same refusal whichever engine ran the turn. */
export const DENY_UNANSWERED: Answer = {
  kind: "deny",
  reason: SYNTHETIC_SESSION_APPROVAL_DENIAL,
};

/**
 * Answer native requests with one answer: approve (the person pre-approved,
 * or a later gate decides) or deny (nobody can answer). `covers` picks the
 * calls it answers; the rest reach the caller unchanged. Framework host-tool
 * gates are not native requests and remain intact.
 */
export function withAnsweredNativeRequests<T extends HarnessV1>(
  harness: T,
  answer: Answer,
  settings: {
    onAnswer?: (approvalId: string) => void;
    pendingApprovalIds?: ReadonlySet<string>;
    /** Sees the call's input too: some runtimes name the server only there. */
    covers?: (toolName: string | undefined, input: unknown) => boolean;
  } = {},
): T {
  const { covers } = settings;
  return withNativeRequestDecisions(
    harness,
    (call) =>
      !covers || covers(call?.name, call?.input) ? answer : { kind: "ask" },
    {
      pendingApprovalIds: settings.pendingApprovalIds,
      onAnswer: (approvalId) => settings.onAnswer?.(approvalId),
    },
  );
}

/**
 * The host-tool half of a turn nobody can answer: each tool whose own
 * declaration asks is refused where it runs, with {@link DENY_UNANSWERED}'s
 * reason in place of its result, and asks nothing. A function-form
 * declaration counts as asking, as it does for `HarnessAgent`'s map.
 */
export function withDeniedGatedHostTools<T extends Record<string, unknown>>(
  tools: T,
): T {
  const out: Record<string, unknown> = { ...tools };
  for (const [name, tool] of Object.entries(tools)) {
    const declared = (tool as { needsApproval?: unknown } | undefined)
      ?.needsApproval;
    if (declared !== true && typeof declared !== "function") continue;
    out[name] = {
      ...(tool as object),
      needsApproval: false,
      execute: async () => ({ error: SYNTHETIC_SESSION_APPROVAL_DENIAL }),
    };
  }
  return out as T;
}
