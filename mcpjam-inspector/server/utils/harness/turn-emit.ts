import type {
  HarnessV1,
  HarnessV1ContinueTurnOptions,
  HarnessV1PromptTurnOptions,
} from "@ai-sdk/harness";

type TurnEmit = HarnessV1PromptTurnOptions["emit"];

/**
 * Rewrite what each turn of a harness's sessions emits; nothing else changes.
 * `wrap` runs once per turn, so its closure holds that turn's state.
 */
export function withTurnEmit<T extends HarnessV1>(
  harness: T,
  wrap: (emit: TurnEmit) => TurnEmit,
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
            const value = Reflect.get(sessionTarget, method);
            if (method !== "doPromptTurn" && method !== "doContinueTurn")
              return typeof value === "function"
                ? value.bind(sessionTarget)
                : value;
            return (
              turn: HarnessV1PromptTurnOptions | HarnessV1ContinueTurnOptions,
            ) =>
              method === "doPromptTurn"
                ? sessionTarget.doPromptTurn({
                    ...turn,
                    emit: wrap(turn.emit),
                  } as HarnessV1PromptTurnOptions)
                : sessionTarget.doContinueTurn({
                    ...turn,
                    emit: wrap(turn.emit),
                  });
          },
        });
      };
    },
  });
}
