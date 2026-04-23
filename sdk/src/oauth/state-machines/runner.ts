import { createOAuthStateMachine } from "./factory.js";
import type {
  MaybePromise,
  OAuthFlowState,
} from "./types.js";
import type { OAuthStateMachineFactoryConfig } from "./factory.js";

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
  onAuthorizationRequest?: (input: {
    authorizationUrl: string;
    state: OAuthFlowState;
  }) => MaybePromise<OAuthAuthorizationRequestResult>;
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
    getState: providedGetState,
    ...machineConfig
  } = config;

  let localState = config.state;
  const updateState = (updates: Partial<OAuthFlowState>) => {
    localState = { ...localState, ...updates };
    config.updateState(updates);
  };
  const getState = providedGetState ?? (() => localState);
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
      return {
        completed: false,
        redirected: false,
        state: getState(),
        error: normalizeError(error),
      };
    }

    const nextState = getState();
    if (nextState.currentStep === startingStep) {
      return {
        completed: false,
        redirected: false,
        state: nextState,
        error: {
          message: nextState.error || `Step ${startingStep} did not advance.`,
        },
      };
    }
  }

  const finalState = getState();
  if (guard >= maxSteps && finalState.currentStep !== "complete") {
    return {
      completed: false,
      redirected: false,
      state: finalState,
      error: {
        message: "OAuth login exceeded its step guard.",
      },
    };
  }

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
