// Production leaves VITE_ENVIRONMENT unset and inherits "production" from
// `.env.production`, so the guard names the environments that may record
// instead of refusing "production".
const RECORDING_ENVIRONMENTS: readonly string[] = ["staging", "preview"];

/**
 * Whether `build:client` injects the Meticulous session recorder.
 *
 * Only hosted web builds of staging and PR previews record, and only when their
 * Railway service sets METICULOUS_RECORDING_TOKEN (a public, read-only token).
 * npm, desktop and local builds never record. The Electron renderer is built by
 * `vite.renderer.config.mts`, which has no recorder at all.
 *
 * A token on any other environment fails the build instead of recording, so
 * production stays off because the deploy breaks, not by convention.
 */
export function shouldRecordWithMeticulous({
  recordingToken,
  environment,
  hostedMode,
  buildSurface,
}: {
  recordingToken: string | undefined;
  environment: string | undefined;
  hostedMode: string | undefined;
  buildSurface: string;
}): boolean {
  if (!recordingToken) return false;
  if (!RECORDING_ENVIRONMENTS.includes(environment ?? "")) {
    throw new Error(
      `METICULOUS_RECORDING_TOKEN is set for a VITE_ENVIRONMENT="${environment ?? ""}" build. Only staging and preview builds record; unset the token on this service.`,
    );
  }
  return hostedMode === "true" && buildSurface === "web";
}
