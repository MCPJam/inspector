export const ONBOARDING_TURN_PHASES = [
  "admission",
  "authorization",
  "connection",
  "tools",
  "model",
  "first_output",
  "terminal",
] as const;

export type OnboardingTurnPhase = (typeof ONBOARDING_TURN_PHASES)[number];
export type OnboardingTraceLastPhase = OnboardingTurnPhase | "received";
export type OnboardingPhaseTimings = Partial<Record<OnboardingTurnPhase, number>>;
