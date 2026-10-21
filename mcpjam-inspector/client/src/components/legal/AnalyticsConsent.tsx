import { useId } from "react";
import { usePostHog } from "posthog-js/react";
import { Button } from "@mcpjam/design-system/button";
import { Switch } from "@mcpjam/design-system/switch";
import { isPostHogDisabled } from "@/lib/PosthogUtils";
import {
  isAnalyticsConsentRequired,
  setAnalyticsConsent,
  useAnalyticsConsent,
} from "@/lib/analytics-consent";
import { PRIVACY_POLICY_URL } from "@/lib/legal-links";

function consentApplies(): boolean {
  return !isPostHogDisabled && isAnalyticsConsentRequired();
}

/** Asks a visitor who must opt in whether optional analytics may run. */
export function AnalyticsConsentBanner() {
  const posthog = usePostHog();
  const consent = useAnalyticsConsent();
  if (!posthog || !consentApplies() || consent !== null) return null;

  // Both buttons share one style: declining must be as easy as allowing.
  return (
    <section
      aria-label="Analytics consent"
      className="fixed inset-x-4 bottom-4 z-50 max-w-md space-y-3 rounded-lg border border-border bg-popover p-4 text-sm text-popover-foreground shadow-md sm:right-auto"
    >
      <p>
        Can MCPJam use analytics and session replay to see how the app is
        used? They stay off unless you allow them. You can change this later
        in Settings, under About.{" "}
        <a
          href={PRIVACY_POLICY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-4"
        >
          Privacy Policy
        </a>
      </p>
      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAnalyticsConsent(posthog, "denied")}
        >
          Decline
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAnalyticsConsent(posthog, "granted")}
        >
          Allow
        </Button>
      </div>
    </section>
  );
}

/**
 * Lets a visitor who had to opt in change their answer, including one whose
 * stored answer still holds after their location stopped requiring it.
 */
export function AnalyticsConsentSetting() {
  const posthog = usePostHog();
  const consent = useAnalyticsConsent();
  const id = useId();
  if (!posthog || isPostHogDisabled) return null;
  if (!isAnalyticsConsentRequired() && consent === null) return null;

  return (
    <div className="flex items-center justify-between gap-4 py-4 text-sm">
      <label htmlFor={id} className="space-y-1">
        <span className="block font-medium text-accent-foreground">
          Analytics and session replay
        </span>
        <span className="block text-muted-foreground">
          Helps us see how MCPJam is used. Off unless you allow it.
        </span>
      </label>
      <Switch
        id={id}
        checked={consent === "granted"}
        onCheckedChange={(checked) =>
          setAnalyticsConsent(posthog, checked ? "granted" : "denied")
        }
      />
    </div>
  );
}
