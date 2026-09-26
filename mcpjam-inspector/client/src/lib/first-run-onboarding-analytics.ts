import { track } from "./analytics";

export type FirstRunOnboardingScreen =
  | "welcome"
  | "server_choice"
  | "project_preparing"
  | "connecting"
  | "loading_tools"
  | "connected"
  | "demo_failure"
  | "personal_server_details";

export type FirstRunServerKind = "demo" | "personal";
export type FirstRunServerTransport = "http" | "stdio";
export type FirstRunAuthentication = "auto" | "oauth" | "none";

export interface FirstRunConnectionAnalyticsContext {
  serverKind: FirstRunServerKind;
  transport?: FirstRunServerTransport;
  authentication?: FirstRunAuthentication;
}

export type FirstRunFailureStage = "validation" | "handshake";
export type FirstRunCancelStage =
  | "project_preparing"
  | "connecting"
  | "loading_tools";
export type FirstRunSuccessStage = "tools_loaded" | "handshake_only";

const LOCATION = "first_run_onboarding";

function connectionProps(context: FirstRunConnectionAnalyticsContext) {
  return {
    server_kind: context.serverKind,
    ...(context.transport ? { transport: context.transport } : {}),
    ...(context.authentication
      ? { authentication: context.authentication }
      : {}),
  };
}

export function trackFirstRunOnboardingEntered(
  screen: FirstRunOnboardingScreen,
): void {
  track("first_run_onboarding_entered", { location: LOCATION, screen });
}

export function trackFirstRunOnboardingScreenViewed(
  screen: FirstRunOnboardingScreen,
): void {
  track("first_run_onboarding_screen_viewed", { location: LOCATION, screen });
}

export function trackFirstRunServerSelected(
  context: FirstRunConnectionAnalyticsContext,
): void {
  track("first_run_onboarding_server_selected", {
    location: LOCATION,
    ...connectionProps(context),
  });
}

export function trackFirstRunConnectionStarted(
  context: FirstRunConnectionAnalyticsContext,
): void {
  track("first_run_onboarding_connection_started", {
    location: LOCATION,
    ...connectionProps(context),
  });
}

export function trackFirstRunConnectionSucceeded(
  context: FirstRunConnectionAnalyticsContext,
  successStage: FirstRunSuccessStage,
  toolCount?: number,
): void {
  track("first_run_onboarding_connection_succeeded", {
    location: LOCATION,
    ...connectionProps(context),
    success_stage: successStage,
    ...(toolCount === undefined ? {} : { tool_count: toolCount }),
  });
}

export function trackFirstRunConnectionFailed(
  context: FirstRunConnectionAnalyticsContext,
  failureStage: FirstRunFailureStage,
): void {
  track("first_run_onboarding_connection_failed", {
    location: LOCATION,
    ...connectionProps(context),
    failure_stage: failureStage,
  });
}

export function trackFirstRunConnectionCancelled(
  context: FirstRunConnectionAnalyticsContext,
  cancelStage: FirstRunCancelStage,
): void {
  track("first_run_onboarding_connection_cancelled", {
    location: LOCATION,
    ...connectionProps(context),
    cancel_stage: cancelStage,
  });
}

export function trackFirstRunSetupLater(): void {
  track("first_run_onboarding_setup_later_clicked", {
    location: LOCATION,
    screen: "server_choice",
  });
}

export function trackFirstRunPlaygroundOpened(
  context: FirstRunConnectionAnalyticsContext,
  toolCount?: number,
): void {
  track("first_run_onboarding_playground_opened", {
    location: LOCATION,
    ...connectionProps(context),
    ...(toolCount === undefined ? {} : { tool_count: toolCount }),
  });
}
