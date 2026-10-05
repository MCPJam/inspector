import type {
  HarnessV1,
  HarnessV1ContinueTurnOptions,
  HarnessV1PromptControl,
  HarnessV1PromptTurnOptions,
} from "@ai-sdk/harness";

/** Pre-approve native requests only. Framework host-tool gates remain intact. */
export function withAutoApprovedNativeRequests<T extends HarnessV1>(
  harness: T,
  onApproval?: (approvalId: string) => void,
  pendingApprovalIds: ReadonlySet<string> = new Set(),
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
                HarnessV1PromptTurnOptions | HarnessV1ContinueTurnOptions,
            ) => {
              const seen = new Set<string>();
              const queued: string[] = [];
              let control: HarnessV1PromptControl | undefined;
              let pending = Promise.resolve();
              let fail!: (error: unknown) => void;
              const failure = new Promise<never>((_, reject) => {
                fail = reject;
              });
              // Startup may emit before the caller can attach to done.
              void failure.catch(() => {});
              const approve = (approvalId: string) => {
                pending = pending.then(async () => {
                  if (!control?.submitToolApproval)
                    throw new Error(
                      "Runtime cannot answer its native approval request",
                    );
                  await control.submitToolApproval({
                    approvalId,
                    approved: true,
                  });
                  onApproval?.(approvalId);
                });
                void pending.catch(fail);
              };
              const emit: typeof options.emit = (part) => {
                if (part.type !== "tool-approval-request") {
                  options.emit(part);
                  return;
                }
                if (pendingApprovalIds.has(part.approvalId)) {
                  options.emit(part);
                  return;
                }
                if (seen.has(part.approvalId)) return;
                seen.add(part.approvalId);
                if (control) approve(part.approvalId);
                else queued.push(part.approvalId);
              };
              control = await (method === "doPromptTurn"
                ? sessionTarget.doPromptTurn({
                    ...options,
                    emit,
                  } as HarnessV1PromptTurnOptions)
                : sessionTarget.doContinueTurn({ ...options, emit }));
              for (const approvalId of queued) approve(approvalId);
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
