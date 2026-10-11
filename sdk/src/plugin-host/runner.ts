import {
  reducePluginSession,
  type PluginSessionCommand,
  type PluginSessionState,
  type PluginTransition,
  type PluginSessionEffect,
} from "./session.js";

type InvocationEffect = Extract<PluginSessionEffect, { type: "invoke" }>;
export interface PluginSessionPorts {
  invoke: (
    effect: InvocationEffect,
    context: { signal: AbortSignal; dispatched: () => void }
  ) => Promise<unknown>;
  release: (instanceId: string, generation: number) => void;
  classifyError: (error: unknown) => {
    errorCode: string;
    outcomeUnknown?: boolean;
  };
  onError?: (
    stage: "observer" | "release" | "completion",
    error: unknown
  ) => void;
}

/** Live-only effect runner. Replay imports the projection, never these ports. */
export function createPluginSessionRunner(
  initial: PluginSessionState,
  ports: PluginSessionPorts
) {
  let state = initial;
  let disposed = false;
  const listeners = new Set<() => void>();
  const active = new Map<string, AbortController>();
  const report = (
    stage: "observer" | "release" | "completion",
    error: unknown
  ) => {
    // Diagnostics cannot break cancellation or the completion fence.
    try {
      ports.onError?.(stage, error);
    } catch {
      /* Adapter owns diagnostics. */
    }
  };
  const failed = (effect: InvocationEffect, error: unknown) => {
    let classification: ReturnType<PluginSessionPorts["classifyError"]>;
    try {
      classification = ports.classifyError(error);
    } catch {
      classification = {
        errorCode: "HOST_ERROR",
        outcomeUnknown:
          state.operations[effect.operation.id]?.dispatched === true,
      };
    }
    dispatch({
      type: "failed",
      operationId: effect.operation.id,
      generation: effect.operation.generation,
      ...classification,
    });
  };
  const dispatch = (command: PluginSessionCommand): PluginTransition => {
    if (disposed) return { state, effects: [], rejection: "SESSION_CLOSED" };
    const transition = reducePluginSession(state, command);
    if (transition.state !== state) {
      state = transition.state;
      for (const listener of listeners) {
        try {
          listener();
        } catch (error) {
          report("observer", error);
        }
      }
    }
    for (const effect of transition.effects) {
      if (effect.type === "cancel") active.get(effect.operationId)?.abort();
      else if (effect.type === "release") {
        try {
          ports.release(effect.instanceId, effect.generation);
        } catch (error) {
          report("release", error);
        }
      } else {
        const current = state.operations[effect.operation.id];
        const instance = state.instances[effect.operation.instanceId];
        if (
          disposed ||
          current?.phase !== "queued" ||
          instance?.generation !== effect.operation.generation ||
          instance.lifecycle !== "active"
        )
          continue;
        const controller = new AbortController();
        active.set(effect.operation.id, controller);
        const generation = effect.operation.generation;
        // Schedule after publishing state so even synchronous adapters see ownership.
        void Promise.resolve()
          .then(() => {
            controller.signal.throwIfAborted();
            if (
              disposed ||
              state.instances[effect.operation.instanceId]?.generation !==
                generation ||
              state.instances[effect.operation.instanceId]?.lifecycle !==
                "active"
            )
              throw new Error("Stale instance");
            return ports.invoke(effect, {
              signal: controller.signal,
              dispatched: () => {
                dispatch({
                  type: "dispatched",
                  operationId: effect.operation.id,
                  generation,
                });
              },
            });
          })
          .then(
            (result) => {
              try {
                dispatch({
                  type: "completed",
                  operationId: effect.operation.id,
                  generation,
                  result,
                });
              } catch (error) {
                report("completion", error);
                failed(effect, error);
              }
            },
            (error) => {
              failed(effect, error);
            }
          )
          .finally(() => {
            active.delete(effect.operation.id);
          });
      }
    }
    return transition;
  };
  return {
    dispatch,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      if (disposed) return;
      for (const instance of Object.values(state.instances))
        if (instance.lifecycle === "active")
          dispatch({ type: "close", instanceId: instance.id });
      disposed = true;
      listeners.clear();
    },
  };
}
