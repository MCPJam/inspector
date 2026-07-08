import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ShieldAlert,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { RadioGroup, RadioGroupItem } from "@mcpjam/design-system/radio-group";
import {
  discoverAuthorizationServer,
  type AsDiscoveryResult,
} from "@/lib/xaa/discovery-client";
import type { XaaAuthServerMode } from "@/lib/xaa/types";
import type { RegistrationDraft } from "./wizard-draft";

interface AuthServerStepProps {
  draft: RegistrationDraft;
  onChange: (updates: Partial<RegistrationDraft>) => void;
  /** Editing a registration that already has a stored secret. */
  hasStoredSecret: boolean;
}

type DiscoveryState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; result: AsDiscoveryResult }
  | { status: "error"; message: string };

function DiscoveryVerdict({ result }: { result: AsDiscoveryResult }) {
  const supportTone =
    result.jwtBearerSupport === "pass"
      ? {
          Icon: CheckCircle2,
          className: "text-green-600 dark:text-green-400",
        }
      : result.jwtBearerSupport === "warn"
        ? { Icon: AlertTriangle, className: "text-amber-500" }
        : { Icon: ShieldAlert, className: "text-red-500" };

  return (
    <div
      data-testid="xaa-reg-discovery-verdict"
      className="space-y-1.5 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs"
    >
      {result.issuer && (
        <div>
          <span className="text-muted-foreground">Issuer: </span>
          <code className="font-mono break-all">{result.issuer}</code>
        </div>
      )}
      <div className="flex items-start gap-1.5">
        <supportTone.Icon
          className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${supportTone.className}`}
        />
        <span className="text-muted-foreground">{result.jwtBearerDetail}</span>
      </div>
      {result.issuerMismatch && (
        <div className="flex items-start gap-1.5">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span className="text-muted-foreground">
            Advertised issuer{" "}
            <code className="font-mono">
              {result.issuerMismatch.advertised}
            </code>{" "}
            doesn&apos;t match the URL you entered.
            {result.issuerMismatch.schemeOnly &&
              " Only the scheme differs — if your server sits behind a TLS-terminating proxy, check its X-Forwarded-Proto handling."}
          </span>
        </div>
      )}
    </div>
  );
}

export function AuthServerStep({
  draft,
  onChange,
  hasStoredSecret,
}: AuthServerStepProps) {
  const [discovery, setDiscovery] = useState<DiscoveryState>({
    status: "idle",
  });

  const discoveryInput = (draft.issuer || draft.tokenEndpoint).trim();

  const handleDiscover = async () => {
    if (!discoveryInput) return;
    setDiscovery({ status: "loading" });
    try {
      const result = await discoverAuthorizationServer(
        draft.issuer.trim()
          ? { issuer: draft.issuer.trim() }
          : { tokenEndpoint: draft.tokenEndpoint.trim() },
      );
      setDiscovery({ status: "success", result });
      onChange({
        ...(result.issuer ? { issuer: result.issuer } : {}),
        // Autofill the token endpoint from metadata when the user hasn't
        // typed one themselves.
        ...(result.tokenEndpoint && !draft.tokenEndpoint.trim()
          ? { tokenEndpoint: result.tokenEndpoint }
          : {}),
      });
    } catch (error) {
      setDiscovery({
        status: "error",
        message: error instanceof Error ? error.message : "Discovery failed",
      });
    }
  };

  const own = draft.authServerMode === "own";

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>Auth server</Label>
        <RadioGroup
          value={draft.authServerMode}
          onValueChange={(value) =>
            onChange({ authServerMode: value as XaaAuthServerMode })
          }
          className="flex flex-col gap-2"
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem value="own" id="xaa-reg-as-own" />
            <Label htmlFor="xaa-reg-as-own" className="font-normal">
              My own auth server (issues access tokens for this resource)
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="mcpjam" id="xaa-reg-as-mcpjam" />
            <Label htmlFor="xaa-reg-as-mcpjam" className="font-normal">
              MCPJam test auth server
            </Label>
          </div>
        </RadioGroup>
      </div>

      {own && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="xaa-reg-issuer">Issuer</Label>
            <div className="flex items-stretch gap-2">
              <Input
                id="xaa-reg-issuer"
                value={draft.issuer}
                onChange={(event) => onChange({ issuer: event.target.value })}
                placeholder="https://auth.example.com"
                autoComplete="off"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 self-stretch"
                onClick={handleDiscover}
                disabled={!discoveryInput || discovery.status === "loading"}
              >
                {discovery.status === "loading" ? (
                  <>
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    Discovering
                  </>
                ) : (
                  "Discover"
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Discover fetches the server&apos;s metadata and fills in the token
              endpoint.
            </p>
          </div>

          {discovery.status === "error" && (
            <div
              data-testid="xaa-reg-discovery-error"
              className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/20 dark:text-red-300"
            >
              {discovery.message}
            </div>
          )}
          {discovery.status === "success" && (
            <DiscoveryVerdict result={discovery.result} />
          )}

          <div className="space-y-1.5">
            <Label htmlFor="xaa-reg-token-endpoint">Token endpoint</Label>
            <Input
              id="xaa-reg-token-endpoint"
              value={draft.tokenEndpoint}
              onChange={(event) =>
                onChange({ tokenEndpoint: event.target.value })
              }
              placeholder="https://auth.example.com/oauth/token"
              autoComplete="off"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="xaa-reg-client-id">Client ID</Label>
            <Input
              id="xaa-reg-client-id"
              value={draft.targetClientId}
              onChange={(event) =>
                onChange({ targetClientId: event.target.value })
              }
              placeholder="Client registered at your auth server"
              autoComplete="off"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="xaa-reg-client-secret">Client secret</Label>
            <Input
              id="xaa-reg-client-secret"
              type="password"
              value={draft.secret}
              onChange={(event) => onChange({ secret: event.target.value })}
              placeholder={hasStoredSecret ? "••••••••" : "Optional"}
              autoComplete="new-password"
            />
            <p className="text-xs text-muted-foreground">
              {hasStoredSecret
                ? "A secret is stored for this registration. Leave blank to keep it; type a new value to replace it."
                : "Stored securely and never shown again."}
            </p>
          </div>
        </>
      )}

      {!own && (
        <p className="text-xs text-muted-foreground">
          MCPJam plays the auth server: it validates the ID-JAG it minted and
          issues the access token itself. No endpoint or credentials needed.
        </p>
      )}
    </div>
  );
}
