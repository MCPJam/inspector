import { useEffect, useState } from "react";
import { ShieldQuestion } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { track } from "@/lib/analytics";

/** Shell-only device consent; Browser permission is independent. */
export function LocalComputerConsentGate({
  onAllow,
  onUseCloud,
  location = "computer_tab_local",
}: {
  onAllow: () => Promise<boolean> | boolean;
  onUseCloud?: () => void;
  location?: "computer_tab_local" | "playground_browser";
}) {
  const [granting, setGranting] = useState(false);
  const [error, setError] = useState(false);

  // Content-free funnel: shown → granted | denied. `cloud_offered` records
  // whether the decline affordance existed at all, since a pure-local
  // inspector has no "Use cloud instead" button and its denials are invisible
  // by construction.
  const cloudOffered = !!onUseCloud;
  useEffect(() => {
    track("local_computer_consent_gate_shown", {
      location,
      cloud_offered: cloudOffered,
    });
  }, [cloudOffered, location]);

  const handleAllow = async () => {
    setGranting(true);
    setError(false);
    try {
      const ok = await onAllow();
      if (!ok) setError(true);
      track("local_computer_consent_granted", {
        location,
        outcome: ok ? "stored" : "failed",
      });
    } catch {
      setError(true);
      track("local_computer_consent_granted", {
        location,
        outcome: "failed",
      });
    } finally {
      setGranting(false);
    }
  };

  const handleUseCloud = () => {
    track("local_computer_consent_denied", { location });
    onUseCloud?.();
  };

  return (
    <div
      data-testid="local-computer-consent-gate"
      className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-lg border border-border/60 bg-muted/20 px-6 py-8 text-center"
    >
      <ShieldQuestion className="size-6 text-muted-foreground" aria-hidden />
      <h2 className="text-base font-semibold text-foreground">
        Allow agents to run commands on this machine?
      </h2>
      <p className="text-sm leading-relaxed text-muted-foreground">
        Enabled tools can run commands as your user account. This permission
        authorizes shell commands; it does not enable the Bash tool on this
        host. The project folder is not a sandbox — commands can read or change
        files and credentials your user can access. Chat approval settings still
        apply.
      </p>
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
          Couldn't authorize this machine. Check that you're signed in and try
          again.
        </p>
      ) : null}
    </div>
  );
}
