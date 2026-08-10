import { useState } from "react";
import { ShieldQuestion } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";

/**
 * First-run consent for the local computer engine. Allowing it grants the
 * device capability (see `useLocalComputerConsent`) that lets agents run bash
 * — and, once the terminal ships, a shell — on THIS machine as the user's own
 * account. Deliberately blunt about that: it is not a sandbox.
 *
 * `onUseCloud` is shown only when a cloud computer is also available, so a
 * pure-local inspector doesn't offer a fallback that doesn't exist.
 */
export function LocalComputerConsentGate({
  onAllow,
  onUseCloud,
}: {
  onAllow: () => Promise<boolean> | boolean;
  onUseCloud?: () => void;
}) {
  const [granting, setGranting] = useState(false);
  const [error, setError] = useState(false);

  const handleAllow = async () => {
    setGranting(true);
    setError(false);
    try {
      const ok = await onAllow();
      if (!ok) setError(true);
    } catch {
      setError(true);
    } finally {
      setGranting(false);
    }
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
        The bash tool runs real commands on this computer, as your user
        account. The project folder is only a starting directory, not a
        sandbox — commands can read or change any files and credentials your
        user can access. Each agent command still asks for approval in chat
        before it runs.
      </p>
      <div className="mt-1 flex items-center gap-2">
        <Button size="sm" onClick={() => void handleAllow()} disabled={granting}>
          {granting ? "Allowing…" : "Allow"}
        </Button>
        {onUseCloud ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onUseCloud}
            disabled={granting}
          >
            Use cloud instead
          </Button>
        ) : null}
      </div>
      {error ? (
        <p className="text-xs text-destructive" data-testid="consent-error">
          Couldn't enable the local computer. Check that you're signed in and
          try again.
        </p>
      ) : null}
    </div>
  );
}
