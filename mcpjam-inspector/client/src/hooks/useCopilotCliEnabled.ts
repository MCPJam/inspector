import { useFeatureFlagEnabled } from "posthog-js/react";
import { HOSTED_MODE } from "@/lib/config";

/**
 * Whether the GitHub Copilot CLI template is offered. Hosted, its own rollout
 * decides. On a local Inspector the hosted rollout does not apply; the template
 * appears once local Copilot is rolled out for this account, since that is what
 * lets a member add a Copilot client that runs on this machine. `undefined`
 * while flags load.
 */
export function useCopilotCliEnabled() {
  const hosted = useFeatureFlagEnabled("copilot-cli-harness");
  const local = useFeatureFlagEnabled("local-copilot-cli-enabled");
  return HOSTED_MODE ? hosted : local;
}
