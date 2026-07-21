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
import { Loader2 } from "lucide-react";

export interface XaaDcrRegistrationStatusProps {
  status?: "registered" | "registering" | "uncertain";
  clientId?: string;
  issuer?: string;
  registeredAt?: number;
  clientSecretExpiresAt?: number;
  tokenEndpointAuthMethod?:
    | "client_secret_post"
    | "client_secret_basic"
    | "none";
  onRegisterNewClient?: () => Promise<void>;
}

function formatDate(value: number | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function XaaDcrRegistrationStatus({
  status,
  clientId,
  issuer,
  registeredAt,
  clientSecretExpiresAt,
  tokenEndpointAuthMethod,
  onRegisterNewClient,
}: XaaDcrRegistrationStatusProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expired =
    status === "registered" &&
    tokenEndpointAuthMethod !== "none" &&
    clientSecretExpiresAt != null &&
    clientSecretExpiresAt <= Date.now();
  const registeredDate = formatDate(registeredAt);

  const reset = async () => {
    if (!onRegisterNewClient || isResetting) return;
    setIsResetting(true);
    setError(null);
    try {
      await onRegisterNewClient();
      setConfirmOpen(false);
    } catch (resetError) {
      setError(
        resetError instanceof Error
          ? resetError.message
          : "Couldn't reset the registration"
      );
    } finally {
      setIsResetting(false);
    }
  };

  let summary = "Not registered. A client will be registered on first connect.";
  if (status === "registering") {
    summary = "Registration in progress.";
  } else if (status === "uncertain") {
    summary =
      "The previous registration outcome is uncertain and requires intervention.";
  } else if (expired) {
    summary = "The registered client credential has expired.";
  } else if (status === "registered") {
    summary = "Registered client.";
  }

  const canReset =
    Boolean(onRegisterNewClient) &&
    (status === "registered" || status === "uncertain");

  return (
    <div className="space-y-2 rounded-md border border-border bg-background/60 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-foreground">
            DCR registration
          </p>
          <p className="text-xs text-muted-foreground">{summary}</p>
          {clientId && status === "registered" && (
            <p className="break-all text-xs text-muted-foreground">
              Client: <span className="font-mono">{clientId}</span>
            </p>
          )}
          {issuer && status === "registered" && (
            <p className="break-all text-xs text-muted-foreground">
              Issuer: <span className="font-mono">{issuer}</span>
            </p>
          )}
          {registeredDate && status === "registered" && (
            <p className="text-xs text-muted-foreground">
              Registered {registeredDate}
            </p>
          )}
        </div>
        {status === "registering" ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : canReset ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setConfirmOpen(true)}
          >
            Register a new client
          </Button>
        ) : null}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Register a new client?</AlertDialogTitle>
            <AlertDialogDescription>
              This clears MCPJam&apos;s stored registration. The next connection
              performs dynamic registration again, and another remote client may
              be created at the authorization server.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isResetting}>
              Keep current registration
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={isResetting}
              onClick={(event) => {
                event.preventDefault();
                void reset();
              }}
            >
              {isResetting ? "Resetting…" : "Register a new client"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
