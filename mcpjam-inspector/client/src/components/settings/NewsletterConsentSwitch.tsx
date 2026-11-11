import { useState } from "react";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { Switch } from "@mcpjam/design-system/switch";

const setMarketingOptInMutation = makeFunctionReference<
  "mutation",
  { optIn: boolean },
  { marketingOptIn: boolean }
>("marketingConsent:setMarketingOptIn");

/**
 * Newsletter opt-in. Off until the person turns it on: an account with no
 * recorded choice is never subscribed. Account email does not depend on it.
 */
export function NewsletterConsentSwitch({
  optedIn,
  loading,
}: {
  optedIn: boolean;
  loading: boolean;
}) {
  const setMarketingOptIn = useMutation(setMarketingOptInMutation);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const handleChange = async (optIn: boolean) => {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await setMarketingOptIn({ optIn });
    } catch (cause) {
      console.error("Failed to save newsletter choice:", cause);
      setError("Your newsletter choice was not saved. Try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-2 border-t border-border pt-7">
      <h2 className="text-sm font-semibold">Newsletter</h2>
      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={optedIn}
          disabled={loading || pending}
          aria-describedby="newsletter-consent-note"
          onCheckedChange={handleChange}
        />
        Email me the MCPJam newsletter
      </label>
      <p id="newsletter-consent-note" className="text-xs text-foreground/80">
        Product updates by email. Turn this off or use the unsubscribe link in
        any newsletter to stop. Emails about your account are sent either way.
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
