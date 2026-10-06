import { useFeatureFlagEnabled } from "posthog-js/react";

/**
 * PostHog rollout gate for custom SANDBOX IMAGES — the `computerEnvironments`
 * blueprints and every place one can be pinned: the Computer tab's image row
 * and drawer, the environment editor's image picker, the composer's image
 * pill, and suite/swarm image pins.
 *
 * Split from `computers-enabled` on purpose. A harness client cannot be saved
 * without a personal computer, so that flag has to widen to everyone who gets
 * a cloud client; this one keeps the custom-image surface internal while it
 * does. The backend enforces the same key (`sandbox-images` in
 * `lib/featureGates.ts`), so the advertised and enforced surfaces move
 * together. The personal computer itself — the Computer tab, the host-editor
 * computer toggle, the Shell rail — stays on `useComputersEnabled`.
 *
 * `useFeatureFlagEnabled` returns `undefined` while flags load — treated as
 * off (`=== true`) so the image surface never flickers on before PostHog
 * resolves.
 */
export const SANDBOX_IMAGES_FEATURE_FLAG = "sandbox-images-enabled";

export function useSandboxImagesEnabled(): boolean {
  return useFeatureFlagEnabled(SANDBOX_IMAGES_FEATURE_FLAG) === true;
}
