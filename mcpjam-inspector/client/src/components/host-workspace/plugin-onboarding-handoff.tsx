import { useEffect, useState } from "react";
import { usePluginOnboardingIntentStore } from "@/lib/plugin-onboarding-intent";
import { logPluginExtensionIssue } from "@/lib/plugin-extension-logs";

const COMPARE_REFUSAL =
  "Setup did not start in Compare. Switch to a single chat, then select Set up in the plugin’s settings.";

/** Compare has no single onboarding owner; never choose a lane for Set up. */
export function PluginOnboardingHandoff({
  projectId,
  compareActive,
}: {
  projectId: string | null | undefined;
  compareActive: boolean;
}) {
  const intent = usePluginOnboardingIntentStore((state) => state.intent);
  const [refusedProject, setRefusedProject] = useState<string | null>(null);
  useEffect(() => {
    setRefusedProject((current) => current === projectId && compareActive ? current : null);
  }, [projectId, compareActive]);
  useEffect(() => {
    if (!compareActive || !projectId || intent?.projectId !== projectId) return;
    const claimed = usePluginOnboardingIntentStore.getState().take(intent.id);
    if (!claimed) return;
    setRefusedProject(projectId);
    logPluginExtensionIssue({
      code: "PLUGIN_ONBOARDING_NOT_STARTED",
      level: "warning",
      message: COMPARE_REFUSAL,
      detail: { serverIds: claimed.serverIds, pluginId: claimed.pluginId },
      dedupeKey: `onboarding:${claimed.id}`,
    });
  }, [compareActive, projectId, intent]);
  if (!compareActive || !projectId || refusedProject !== projectId) return null;
  return (
    <p role="alert" className="px-3 py-2 text-sm text-destructive">
      {COMPARE_REFUSAL}
    </p>
  );
}
