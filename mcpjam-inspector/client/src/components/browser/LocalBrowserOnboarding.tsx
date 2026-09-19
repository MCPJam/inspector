import { useBrowserEngine } from "@/hooks/useBrowserEngine";
import { useLocalBrowserEnabled } from "@/hooks/useComputersEnabled";
import { useLocalBrowserOnboarding } from "@/hooks/useLocalBrowserOnboarding";
import { HOSTED_MODE } from "@/lib/config";
import { LocalBrowserConsentGate } from "./LocalBrowserConsentGate";

/** Mounted once at the Playground root, independent of the active chat/client. */
export function LocalBrowserOnboarding({
  projectId,
  authReady,
}: {
  projectId: string | null;
  authReady: boolean;
}) {
  const enabled = useLocalBrowserEnabled();
  const engine = useBrowserEngine(projectId);
  const onboarding = useLocalBrowserOnboarding();
  if (
    HOSTED_MODE ||
    !authReady ||
    !enabled ||
    !engine.resolved ||
    !engine.localAvailable ||
    engine.environmentMode ||
    engine.selectedEngine !== "local" ||
    !onboarding.undecided
  )
    return null;

  return (
    <LocalBrowserConsentGate
      variant="onboarding"
      location="playground_onboarding"
      setupOnly={!!engine.consent.token}
      onAllow={engine.consent.grant}
      onDismiss={onboarding.dismiss}
    />
  );
}
