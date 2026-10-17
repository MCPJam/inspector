import type {
  OAuthFlowState,
  OAuthFlowStep,
  OAuthStateMachine,
} from "@mcpjam/sdk/browser";

// The steps between the authorization callback and the tokens.
const CODE_REDEMPTION_STEPS = new Set<OAuthFlowStep>([
  "authorization_request",
  "received_authorization_code",
  "token_request",
]);

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
 * these steps altogether.
 */
export async function redeemAuthorizationCode(
  machine: Pick<OAuthStateMachine, "proceedToNextStep"> | null,
  flowState: { readonly current: OAuthFlowState },
): Promise<void> {
  if (!machine) return;
  let step = flowState.current.currentStep;
  while (CODE_REDEMPTION_STEPS.has(step)) {
    await machine.proceedToNextStep();
    const next = flowState.current.currentStep;
    if (next === step) return;
    step = next;
  }
}
