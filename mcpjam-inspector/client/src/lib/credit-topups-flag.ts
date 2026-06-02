import { useFeatureFlagEnabled } from "posthog-js/react";

export const CREDIT_TOPUPS_UI_FLAG = "credit-topups-ui";

export function useCreditTopupsUiEnabled(): boolean {
  return useFeatureFlagEnabled(CREDIT_TOPUPS_UI_FLAG) === true;
}
