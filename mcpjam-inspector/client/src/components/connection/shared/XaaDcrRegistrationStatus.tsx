import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { Info } from "lucide-react";

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
}: XaaDcrRegistrationStatusProps) {
  const expired =
    status === "registered" &&
    tokenEndpointAuthMethod !== "none" &&
    clientSecretExpiresAt != null &&
    clientSecretExpiresAt <= Date.now();
  const registeredDate = formatDate(registeredAt);

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

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="DCR registration details"
          className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" variant="muted" className="max-w-sm space-y-1">
        <p className="font-medium">DCR registration</p>
        <p>{summary}</p>
        {clientId && status === "registered" && (
          <p className="break-all">
            Client: <span className="font-mono">{clientId}</span>
          </p>
        )}
        {issuer && status === "registered" && (
          <p className="break-all">
            Issuer: <span className="font-mono">{issuer}</span>
          </p>
        )}
        {registeredDate && status === "registered" && (
          <p>Registered {registeredDate}</p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
