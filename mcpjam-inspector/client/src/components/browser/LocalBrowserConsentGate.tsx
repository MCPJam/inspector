import { useEffect, useState } from "react";
import { Globe } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { track } from "@/lib/analytics";
import { HOSTED_MODE } from "@/lib/config";
import { useAuth } from "@workos-inc/authkit-react";

/** Explicit device consent and shared local-client setup. */
export function LocalBrowserConsentGate({
  onAllow,
  onUseCloud,
  location = "computer_tab_local",
}: {
  onAllow: () => Promise<boolean> | boolean;
  onUseCloud?: () => void;
  location?: "computer_tab_local" | "playground_browser" | "browser_settings";
}) {
  const { user } = useAuth();
  const [granting, setGranting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Content-free funnel: shown → granted | denied. `cloud_offered` records
  // whether the decline affordance existed at all, since a pure-local
  // inspector has no "Use cloud instead" button and its denials are invisible
  // by construction.
  const cloudOffered = !!onUseCloud;
  useEffect(() => {
    if (HOSTED_MODE) return;
    track("local_browser_consent_gate_shown", {
      location,
      cloud_offered: cloudOffered,
    });
  }, [cloudOffered, location]);

  const handleAllow = async () => {
    setGranting(true);
    setError(null);
    try {
      const ok = await onAllow();
      if (!ok) setError("Couldn't finish Browser setup. Try again.");
      track("local_browser_consent_granted", {
        location,
        outcome: ok ? "stored" : "failed",
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Couldn't finish Browser setup. Try again.",
      );
      track("local_browser_consent_granted", {
        location,
        outcome: "failed",
      });
    } finally {
      setGranting(false);
    }
  };

  const handleUseCloud = () => {
    track("local_browser_consent_denied", { location });
    onUseCloud?.();
  };

  if (HOSTED_MODE) return null;
  return (
    <div
      data-testid="local-browser-consent-gate"
      className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-lg border border-border/60 bg-muted/20 px-6 py-8 text-center"
    >
      <Globe className="size-6 text-muted-foreground" aria-hidden />
      <h2 className="text-base font-semibold text-foreground">
        Enable local Browser for all clients
      </h2>
      <p className="text-sm leading-relaxed text-muted-foreground">
        Allow agents to navigate, click, type, and read pages on this machine.
        Page content may be sent to your model.{" "}
        {user
          ? "This enables local Browser for all clients in projects you manage, including shared clients. You can remove it in each client's Connect settings."
          : "This enables Browser for your local clients across WebMCP, Playground, and tabs on this device."}
      </p>
      {user && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          New clients inherit this setting. Clients you've disabled stay
          disabled. Teammates must allow browser access on their own machines.
        </p>
      )}
      <div className="mt-1 flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => void handleAllow()}
          disabled={granting}
        >
          {granting ? "Allowing…" : "Allow"}
        </Button>
        {onUseCloud ? (
          <Button
            size="sm"
            variant="outline"
            onClick={handleUseCloud}
            disabled={granting}
          >
            Use cloud instead
          </Button>
        ) : null}
      </div>
      {error ? (
        <p className="text-xs text-destructive" data-testid="consent-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
