/**
 * The Free plan's native harness trial, as the backend defines it
 * (`convex/lib/nativeHarnessTrial.ts` in mcpjam-backend). Spelled here rather
 * than imported: this repo does not depend on the backend's source.
 */

/** The refusal a native turn gets once the organization's trial is used up. */
export const NATIVE_HARNESS_TRIAL_EXHAUSTED_CODE =
  "native_harness_trial_exhausted";

/**
 * The trial's size. The backend's answer wins wherever one is in hand; this is
 * only what the refusal dialog says while that answer is still loading.
 */
export const NATIVE_HARNESS_TRIAL_TURNS = 20;
