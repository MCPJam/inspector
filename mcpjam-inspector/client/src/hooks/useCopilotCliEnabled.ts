import { useFeatureFlagEnabled } from "posthog-js/react";
import { HOSTED_MODE } from "@/lib/config";

export function useCopilotCliEnabled() {
  const enabled = useFeatureFlagEnabled("client-agent-loop");
  return HOSTED_MODE ? enabled : false;
}
