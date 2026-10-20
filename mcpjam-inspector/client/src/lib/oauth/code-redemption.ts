import {
  getStepIndex,
  type OAuthFlowState,
  type OAuthFlowStep,
  type OAuthStateMachine,
} from "@mcpjam/sdk/browser";

// The steps from the authorization callback through the token request, read
// off the SDK's step order so a step the machines add in between is included.
const isRedemptionStep = (step: OAuthFlowStep) =>
  getStepIndex(step) >= getStepIndex("authorization_request") &&
  getStepIndex(step) <= getStepIndex("token_request");

/**
 * Run the OAuth debugger from the authorization callback through the token
 * exchange, instead of one step per Continue click. Servers expire a code
 * within seconds to minutes (Keycloak's default is 60 seconds), so a code that
 * waits on a click at each step can reach the token endpoint as `invalid_grant`.
 * Signing in is the user's click for these steps; the request and response
 * stay in the HTTP history to inspect afterwards.
 *
 * Stops wherever the machine does not advance: a rejected code or a refused
 * issuer stays on its step with the error set, and a flow reset mid-way leaves
 * these steps altogether. Does not start while a step is in flight: Continue
 * and the agent stay live until the caller's timer fires, and if that step is
 * the exchange, a second one would spend the single-use code again.
 */
export async function redeemAuthorizationCode(
  machine: Pick<OAuthStateMachine, "proceedToNextStep"> | null,
  flowState: { readonly current: OAuthFlowState },
): Promise<void> {
  if (!machine || flowState.current.isInitiatingAuth) return;
  let step = flowState.current.currentStep;
  while (isRedemptionStep(step)) {
    await machine.proceedToNextStep();
    const next = flowState.current.currentStep;
    if (next === step) return;
    step = next;
  }
}
