import type {
  HarnessV1,
  HarnessV1ContinueTurnOptions,
  HarnessV1PromptControl,
  HarnessV1PromptTurnOptions,
} from "@ai-sdk/harness";
import type { ElicitationCallbackRequest } from "@mcpjam/sdk";
import type { ElicitResult } from "@modelcontextprotocol/client";
import { z } from "zod/v4";

const PRIVATE_EVENT = "mcpjam:elicitation";
const controlId = z.string().startsWith(`${PRIVATE_EVENT}:`).max(512);
const requestEvent = z.object({
  type: z.literal(PRIVATE_EVENT),
  phase: z.literal("request"),
  controlId,
  request: z.object({
    serverName: z.string().min(1).max(512),
    message: z.string(),
    mode: z.enum(["form", "url"]).optional(),
    requestedSchema: z.record(z.string(), z.unknown()).optional(),
    url: z.string().optional(),
    elicitationId: z.string().optional(),
  }),
});
const cancelEvent = z.object({
  type: z.literal(PRIVATE_EVENT),
  phase: z.literal("cancel"),
  controlId,
});

export interface HarnessElicitationHandler {
  (
    request: ElicitationCallbackRequest,
    signal: AbortSignal,
  ): Promise<ElicitResult>;
}

/** Consume private control events before the agent's raw-event persistence. */
export function withHarnessElicitation<T extends HarnessV1>(
  harness: T,
  args: {
    keyToServerId: Readonly<Record<string, string>>;
    allowedServerIds: ReadonlySet<string>;
    handle: HarnessElicitationHandler;
    signal: AbortSignal;
  },
): T {
  return new Proxy(harness, {
    get(target, key) {
      if (key !== "doStart") {
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (options: Parameters<T["doStart"]>[0]) => {
        const session = await target.doStart(options);
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
                | HarnessV1PromptTurnOptions
                | HarnessV1ContinueTurnOptions,
            ) => {
              const requests = new Map<string, AbortController>();
              const cancelled = new Set<string>();
              const pending = new Set<Promise<void>>();
              type Ready =
                | { control: HarnessV1PromptControl }
                | { error: unknown };
              let resolveControl!: (ready: Ready) => void;
              const ready = new Promise<Ready>((resolve) => {
                resolveControl = resolve;
              });
              let fail!: (error: unknown) => void;
              const failure = new Promise<{ error: unknown }>((resolve) => {
                fail = (error) => resolve({ error });
              });
              const abort = () => {
                for (const controller of requests.values()) controller.abort();
              };
              args.signal.addEventListener("abort", abort, { once: true });
              const emit: typeof options.emit = (part) => {
                const raw = part.type === "raw" ? part.rawValue : undefined;
                if (
                  !raw ||
                  typeof raw !== "object" ||
                  !("type" in raw) ||
                  raw.type !== PRIVATE_EVENT
                ) {
                  options.emit(part);
                  return;
                }
                const cancellation = cancelEvent.safeParse(raw);
                if (cancellation.success) {
                  cancelled.add(cancellation.data.controlId);
                  requests.get(cancellation.data.controlId)?.abort();
                  return;
                }
                const parsed = requestEvent.safeParse(raw);
                if (!parsed.success) {
                  fail(new Error("Invalid harness elicitation control event"));
                  return;
                }
                const { controlId: id, request } = parsed.data;
                if (requests.has(id)) return;
                const controller = new AbortController();
                requests.set(id, controller);
                if (args.signal.aborted || cancelled.has(id))
                  controller.abort();
                const work = (async () => {
                  const serverId = Object.hasOwn(
                    args.keyToServerId,
                    request.serverName,
                  )
                    ? args.keyToServerId[request.serverName]
                    : undefined;
                  const result =
                    !serverId ||
                    controller.signal.aborted ||
                    request.mode === "url"
                      ? { action: "cancel" as const }
                      : !args.allowedServerIds.has(serverId)
                        ? { action: "decline" as const }
                        : await args.handle(
                            {
                              requestId: id,
                              serverId,
                              message: request.message,
                              mode: request.mode ?? "form",
                              schema: request.requestedSchema,
                              url: request.url,
                              elicitationId: request.elicitationId,
                            },
                            controller.signal,
                          );
                  const state = await ready;
                  if ("error" in state) throw state.error;
                  await state.control.submitToolResult({
                    toolCallId: id,
                    output: controller.signal.aborted
                      ? { action: "cancel" }
                      : result,
                  });
                })();
                pending.add(work);
                void work.then(
                  () => pending.delete(work),
                  (error) => {
                    pending.delete(work);
                    fail(error);
                  },
                );
              };
              try {
                const turnOptions = { ...options, emit };
                let control: HarnessV1PromptControl;
                if (method === "doPromptTurn") {
                  if (!("prompt" in turnOptions))
                    throw new Error("Missing harness turn prompt");
                  control = await sessionTarget.doPromptTurn(turnOptions);
                } else {
                  control = await sessionTarget.doContinueTurn(turnOptions);
                }
                resolveControl({ control });
                return {
                  ...control,
                  submitToolResult: control.submitToolResult.bind(control),
                  submitToolApproval: control.submitToolApproval?.bind(control),
                  submitUserMessage: control.submitUserMessage?.bind(control),
                  done: Promise.race([Promise.resolve(control.done), failure])
                    .then((outcome) => {
                      if (outcome && "error" in outcome) throw outcome.error;
                    })
                    .finally(async () => {
                      abort();
                      args.signal.removeEventListener("abort", abort);
                      await Promise.allSettled([...pending]);
                    }),
                };
              } catch (error) {
                resolveControl({ error });
                abort();
                args.signal.removeEventListener("abort", abort);
                throw error;
              }
            };
          },
        });
      };
    },
  });
}
