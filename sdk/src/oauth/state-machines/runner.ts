import { createOAuthStateMachine } from "./factory.js";
import type {
  MaybePromise,
  OAuthFlowState,
} from "./types.js";
import type { OAuthStateMachineFactoryConfig } from "./factory.js";
import {
  createOAuthTraceProjectionContext,
  projectOAuthTraceSnapshot,
  type OAuthTraceProjectionContext,
  type OAuthTraceSnapshot,
} from "./trace.js";

export type OAuthAuthorizationRequestResult =
  | {
      type: "authorization_code";
      authorizationCode: string;
    }
  | {
      type: "redirect";
    };

export interface OAuthStateMachineRunConfig
  extends OAuthStateMachineFactoryConfig {
  maxSteps?: number;
  /** When true (default), trace snapshots redact secrets. Set false for local dev tooling. */
  sanitizeTrace?: boolean;
  onAuthorizationRequest?: (input: {
    authorizationUrl: string;
    state: OAuthFlowState;
  }) => MaybePromise<OAuthAuthorizationRequestResult>;
  onTraceUpdate?: (input: {
    trace: OAuthTraceSnapshot;
    state: OAuthFlowState;
    reason: "state_update" | "redirect" | "error" | "complete";
  }) => void;
}

export interface OAuthStateMachineRunResult {
  completed: boolean;
  redirected: boolean;
  authorizationUrl?: string;
  state: OAuthFlowState;
  error?: {
    message: string;
  };
}

function normalizeError(error: unknown): { message: string } {
  return {
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function runOAuthStateMachine(
  config: OAuthStateMachineRunConfig,
): Promise<OAuthStateMachineRunResult> {
  const {
    maxSteps = 40,
    onAuthorizationRequest,
    onTraceUpdate,
    getState: providedGetState,
    sanitizeTrace = true,
    ...machineConfig
  } = config;

  let localState = config.state;
  const traceProjectionContext = createOAuthTraceProjectionContext();
  const getState = providedGetState ?? (() => localState);
  const emitTrace = (
    reason: "state_update" | "redirect" | "error" | "complete",
    state = getState(),
    context: OAuthTraceProjectionContext = traceProjectionContext,
  ) => {
    onTraceUpdate?.({
      trace: projectOAuthTraceSnapshot({
        state,
        context,
        sanitize: sanitizeTrace,
      }),
      state,
      reason,
    });
  };
  const updateState = (updates: Partial<OAuthFlowState>) => {
    localState = { ...localState, ...updates };
    config.updateState(updates);
    emitTrace("state_update", localState);
  };
  const machine = createOAuthStateMachine({
    ...machineConfig,
    getState,
    updateState,
  });

  let guard = 0;
  while (getState().currentStep !== "complete" && guard < maxSteps) {
    guard += 1;
    const currentState = getState();

    if (currentState.currentStep === "authorization_request") {
      if (!currentState.authorizationUrl) {
        updateState({
          error: "Authorization URL was not generated.",
        });
        return {
          completed: false,
          redirected: false,
          state: getState(),
          error: {
            message: "Authorization URL was not generated.",
          },
        };
      }

      if (!onAuthorizationRequest) {
        updateState({
          error: "Authorization request requires an authorization handler.",
        });
        return {
          completed: false,
          redirected: false,
          authorizationUrl: currentState.authorizationUrl,
          state: getState(),
          error: {
            message: "Authorization request requires an authorization handler.",
          },
        };
      }

      try {
        const authorizationResult = await onAuthorizationRequest({
          authorizationUrl: currentState.authorizationUrl,
          state: currentState,
        });

        if (authorizationResult.type === "redirect") {
          emitTrace("redirect");
          return {
            completed: false,
            redirected: true,
            authorizationUrl: currentState.authorizationUrl,
            state: getState(),
          };
        }

        updateState({
          currentStep: "received_authorization_code",
          authorizationCode: authorizationResult.authorizationCode,
          error: undefined,
        });
        continue;
      } catch (error) {
        updateState({
          error: normalizeError(error).message,
        });
        return {
          completed: false,
          redirected: false,
          authorizationUrl: currentState.authorizationUrl,
          state: getState(),
          error: normalizeError(error),
        };
      }
    }

    const startingStep = currentState.currentStep;

    try {
      await machine.proceedToNextStep();
    } catch (error) {
      if (!getState().error) {
        updateState({
          error: normalizeError(error).message,
        });
      } else {
        emitTrace("error");
      }
      return {
        completed: false,
        redirected: false,
        state: getState(),
        error: normalizeError(error),
      };
    }

    const nextState = getState();
    if (nextState.currentStep === startingStep) {
      if (!nextState.error) {
        updateState({
          error: `Step ${startingStep} did not advance.`,
        });
      } else {
        emitTrace("error", nextState);
      }
      return {
        completed: false,
        redirected: false,
        state: getState(),
        error: {
          message:
            getState().error || `Step ${startingStep} did not advance.`,
        },
      };
    }
  }

  const finalState = getState();
  if (guard >= maxSteps && finalState.currentStep !== "complete") {
    updateState({
      error: "OAuth login exceeded its step guard.",
    });
    return {
      completed: false,
      redirected: false,
      state: getState(),
      error: {
        message: "OAuth login exceeded its step guard.",
      },
    };
  }

  emitTrace(finalState.currentStep === "complete" ? "complete" : "state_update");
  return {
    completed: finalState.currentStep === "complete",
    redirected: false,
    authorizationUrl: finalState.authorizationUrl,
    state: finalState,
    ...(finalState.error
      ? {
          error: {
            message: finalState.error,
          },
        }
      : {}),
  };
}
