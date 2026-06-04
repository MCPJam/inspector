import { useFeatureFlagEnabled } from "posthog-js/react";

export const TEAM_CREDITS_UI_FLAG = "team-credits-ui";

export function useTeamCreditsUiEnabled(): boolean {
  return useFeatureFlagEnabled(TEAM_CREDITS_UI_FLAG) === true;
}
