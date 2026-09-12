import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@mcpjam/design-system/dialog";
import { useEffect, useRef, useState } from "react";
import { Globe } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { track } from "@/lib/analytics";
import { HOSTED_MODE } from "@/lib/config";
import { routePaths, useAppNavigate } from "@/lib/app-navigation";
import { useAuth } from "@workos-inc/authkit-react";

/** Shared consent copy — one description across card, inline, and onboarding. */
function LocalBrowserConsentDescription({
  guest,
  onOpenBrowserSettings,
  linkClassName = "text-sm",
}: {
  guest: boolean;
  onOpenBrowserSettings?: () => void;
  linkClassName?: string;
}) {
  const navigate = useAppNavigate();
  const openSettings =
    onOpenBrowserSettings ?? (() => navigate(routePaths.hosts));

  if (guest) {
    return (
      <>
        Allow agents to navigate, click, type, and read pages on this machine.
        Page content may be sent to your model. This enables Browser for your
        local clients across WebMCP, Playground, and tabs on this device.
      </>
    );
  }

  return (
    <>
      Allow agents to navigate, click, type, and read pages on this machine.
      Page content may be sent to your model. You can remove it in each{" "}
      <Button
        variant="link"
        className={`h-auto p-0 ${linkClassName}`}
        onClick={openSettings}
      >
        Browser settings
      </Button>
      .
    </>
  );
}

/** Explicit device consent and shared local-client setup. */
export function LocalBrowserConsentGate({
  onAllow,
  onUseCloud,
  location = "computer_tab_local",
  variant = "card",
  onOpenClientSettings,
  onDismiss,
  setupOnly = false,
}: {
  onAllow: () => Promise<boolean> | boolean;
  onUseCloud?: () => void;
  location?:
    | "computer_tab_local"
    | "playground_browser"
    | "playground_onboarding"
    | "playground_tools"
    | "browser_settings";
  /** `inline` fits a list row (the Tools rail); `card` fills a pane. */
  variant?: "card" | "inline" | "onboarding";
  onDismiss?: () => void;
  setupOnly?: boolean;
  /** Opens the client's Browser settings, where Allow can be undone. */
  onOpenClientSettings?: () => void;
}) {
  const { user } = useAuth();
  const submitting = useRef(false);
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
    if (submitting.current) return;
    submitting.current = true;
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
      submitting.current = false;
      setGranting(false);
    }
  };

  const handleUseCloud = () => {
    track("local_browser_consent_denied", { location });
    onUseCloud?.();
  };

  if (HOSTED_MODE) return null;
  if (variant === "onboarding") {
    const dismiss = () => {
      if (submitting.current) return;
      track("local_browser_consent_denied", { location, reason: "not_now" });
      onDismiss?.();
    };
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) dismiss();
        }}
      >
        <DialogContent
          showCloseButton={!granting}
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            if (submitting.current) event.preventDefault();
          }}
          className="max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-lg"
        >
          <Globe className="size-8 text-primary" aria-hidden />
          <DialogTitle>
            {setupOnly
              ? "Finish enabling browser tools"
              : "Let agents use your browser?"}
          </DialogTitle>
          <DialogDescription asChild>
            <p className="text-sm text-muted-foreground">
              {setupOnly ? (
                <>
                  Browser permission is saved. Finish setup to enable browser
                  tools for your clients.
                </>
              ) : (
                <LocalBrowserConsentDescription
                  guest={!user}
                  {...(onOpenClientSettings
                    ? { onOpenBrowserSettings: onOpenClientSettings }
                    : {})}
                />
              )}
            </p>
          </DialogDescription>
          {error ? (
            <p
              role="alert"
              className="text-sm text-destructive"
              data-testid="consent-error"
            >
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={granting} onClick={dismiss}>
              Not now
            </Button>
            <Button disabled={granting} onClick={() => void handleAllow()}>
              {granting
                ? "Enabling browser…"
                : error
                ? "Retry setup"
                : setupOnly
                ? "Finish setup"
                : "Allow browser access"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
  if (variant === "inline") {
    return (
      <div
        data-testid="local-browser-consent-inline"
        className="space-y-2 px-3"
      >
        <p className="text-xs leading-snug text-muted-foreground">
          <LocalBrowserConsentDescription
            guest={!user}
            linkClassName="text-xs"
            {...(onOpenClientSettings
              ? { onOpenBrowserSettings: onOpenClientSettings }
              : {})}
          />
        </p>
        <Button
          size="sm"
          onClick={() => void handleAllow()}
          disabled={granting}
        >
          {granting ? "Allowing…" : "Allow"}
        </Button>
        {error ? (
          <p className="text-xs text-destructive" data-testid="consent-error">
            {error}
          </p>
        ) : null}
      </div>
    );
  }
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
        <LocalBrowserConsentDescription
          guest={!user}
          {...(onOpenClientSettings
            ? { onOpenBrowserSettings: onOpenClientSettings }
            : {})}
        />
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
