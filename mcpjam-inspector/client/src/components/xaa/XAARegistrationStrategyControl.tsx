import { useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
import type { XaaRegistrationStrategy } from "@/lib/xaa/types";

const STRATEGY_OPTIONS: Array<{
  value: XaaRegistrationStrategy;
  label: string;
}> = [
  { value: "pre_registered", label: "Pre-registered client" },
  { value: "dcr", label: "Open dynamic registration (DCR)" },
  { value: "cimd", label: "Client metadata URL (CIMD)" },
];

const STRATEGY_HINTS: Record<XaaRegistrationStrategy, string> = {
  pre_registered:
    "Uses the client ID and secret you registered at the authorization server yourself.",
  dcr: "Creates a real client at this authorization server. MCPJam keeps its credentials only for this browser session; the remote registration may remain after the session ends. Protected DCR requiring an initial access token is not tested.",
  cimd: "Uses MCPJam's hosted metadata URL as the client_id. It does not request a DCR-created client, though the authorization server may fetch/cache the document. This mode is public (no client authentication) and requires advertised CIMD support.",
};

interface XAARegistrationStrategyControlProps {
  value: XaaRegistrationStrategy;
  onChange: (next: XaaRegistrationStrategy) => void;
  disabled?: boolean;
  /** Show the confirmed "Register another client" action (a session
   * registration exists, or a prior attempt may have created one). */
  showRegisterAnotherClient?: boolean;
  onRegisterAnotherClient?: () => void;
}

/**
 * How this run establishes its client identity at the target authorization
 * server (the Client<->RAS relationship). Deliberately rendered with the
 * target configuration, NOT in the IdP card — the IdP card is MCPJam's
 * Client<->IdP side of the triangle.
 */
export function XAARegistrationStrategyControl({
  value,
  onChange,
  disabled,
  showRegisterAnotherClient,
  onRegisterAnotherClient,
}: XAARegistrationStrategyControlProps) {
  const [confirmReregister, setConfirmReregister] = useState(false);

  return (
    <div className="border-b border-border bg-muted/30 px-4 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Client registration
        </span>
        <div className="flex items-center gap-1" role="radiogroup">
          {STRATEGY_OPTIONS.map((option) => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={value === option.value ? "secondary" : "ghost"}
              className="h-6 text-xs"
              disabled={disabled}
              role="radio"
              aria-checked={value === option.value}
              onClick={() => {
                if (option.value !== value) onChange(option.value);
              }}
            >
              {option.label}
            </Button>
          ))}
        </div>
        {value === "dcr" && showRegisterAnotherClient ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 text-xs text-muted-foreground"
            disabled={disabled}
            onClick={() => setConfirmReregister(true)}
          >
            Register another client
          </Button>
        ) : null}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {STRATEGY_HINTS[value]}
      </p>

      <AlertDialog
        open={confirmReregister}
        onOpenChange={setConfirmReregister}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Register another client?</AlertDialogTitle>
            <AlertDialogDescription>
              This performs a new registration at the authorization server. A
              second remote client may be created there — registrations are
              not automatically deleted. This session&apos;s cached credentials
              are discarded and the flow resets.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep current registration</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onRegisterAnotherClient?.();
                setConfirmReregister(false);
              }}
            >
              Register another client
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
