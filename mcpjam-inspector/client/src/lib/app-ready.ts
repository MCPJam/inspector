/**
 * Shared types and errors for the app-readiness pattern.
 *
 * `useAppReady()` (in `hooks/use-app-ready.ts`) returns one of these states.
 * Request-initiating UI surfaces consult it and disable their controls while
 * bootstrapping; request builders throw `BootstrapNotReadyError` if invoked
 * while not-ready, so a malformed body never reaches the network.
 */

export type AppReadyStatus =
  | { status: "ready"; projectId: string | null }
  | { status: "bootstrapping"; reason: AppReadyBootstrapReason };

export type AppReadyBootstrapReason =
  | "loading-app-state"
  | "resolving-auth"
  | "provisioning-project";

export class BootstrapNotReadyError extends Error {
  readonly reason: AppReadyBootstrapReason;

  constructor(reason: AppReadyBootstrapReason, detail?: string) {
    super(
      detail
        ? `App is still bootstrapping (${reason}): ${detail}`
        : `App is still bootstrapping (${reason}). Wait for useAppReady() to resolve before initiating requests.`,
    );
    this.name = "BootstrapNotReadyError";
    this.reason = reason;
  }
}
