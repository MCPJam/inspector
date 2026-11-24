import { useState } from "react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import { Button } from "@mcpjam/design-system/button";
import { Card, CardContent, CardHeader } from "@mcpjam/design-system/card";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import { Switch } from "@mcpjam/design-system/switch";
import { SettingsPageDescription } from "@/components/settings/SettingsPageDescription";
import { useCredentialExportPolicy } from "@/hooks/useCredentialExportPolicy";

/**
 * Backend refusals under a deny name this label and "Organization settings
 * under Security" (`CREDENTIAL_EXPORT_SETTING_HINT` in the backend's
 * `convex/lib/credentialBroker.ts`, and `credential-export-setting.ts` here).
 * Rename them together.
 */
export const CREDENTIAL_EXPORT_TOGGLE_LABEL = "Allow credential export";

const ON_DESCRIPTION =
  "Members' local apps, the CLI and sandboxes can receive saved OAuth tokens, API keys and secrets, and people who manage them can reveal them in the browser. Shared sign-ins also need Allow local runs on their server.";
const OFF_DESCRIPTION =
  "Only MCPJam-hosted connections can use saved OAuth tokens, API keys and secrets. Local apps, the CLI, sandboxes and browser reveals are refused.";
const DELIVERED_NOTE =
  "Turning this off stops new deliveries. Tokens already on members' computers keep working until they expire, and keys or secrets already sent keep working until you rotate them.";

export function OrganizationSecuritySection({
  organizationId,
  isAdmin,
}: {
  organizationId: string;
  isAdmin: boolean;
}) {
  return (
    <section className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-accent-foreground">
          Security
        </h1>
        <SettingsPageDescription>
          Control where your organization&apos;s saved credentials can be used.
        </SettingsPageDescription>
      </header>
      <CredentialExportCard organizationId={organizationId} isAdmin={isAdmin} />
    </section>
  );
}

/**
 * The organization's credential export switch. On is the default. Turning it
 * off is the kill switch for every delivery that hands a saved credential to
 * a process or page a member controls, so it asks first; turning it back on
 * does not.
 */
function CredentialExportCard({
  organizationId,
  isAdmin,
}: {
  organizationId: string;
  isAdmin: boolean;
}) {
  const { exportPolicy, isLoading, error, isSaving, setExportPolicy } =
    useCredentialExportPolicy(organizationId);
  const [confirmingOff, setConfirmingOff] = useState(false);

  const ready = exportPolicy !== undefined;
  const allowed = exportPolicy !== "deny";
  const disabled = !isAdmin || isSaving || !ready;
  const showConfirmOff = confirmingOff && allowed && isAdmin;

  const save = (next: "allow" | "deny") => {
    void setExportPolicy(next)
      .catch(() => {
        // The hook shows the failure on this card (`useOrgScopedWrite`).
      })
      .finally(() => setConfirmingOff(false));
  };

  return (
    <Card
      className="gap-4 border-0 bg-transparent py-0 shadow-none"
      data-testid="org-credential-export-card"
    >
      <CardHeader className="px-0">
        <h2 className="text-lg font-semibold text-accent-foreground">
          Credential export
        </h2>
      </CardHeader>
      <CardContent className="space-y-3 p-0">
        {error ? (
          <Alert
            variant="destructive"
            data-testid="org-credential-export-error"
          >
            <AlertTitle>
              Couldn&apos;t save the credential export setting
            </AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {CREDENTIAL_EXPORT_TOGGLE_LABEL}
            </p>
            {ready ? (
              <p
                className="text-xs text-muted-foreground"
                data-testid="org-credential-export-description"
              >
                {allowed ? ON_DESCRIPTION : OFF_DESCRIPTION}
              </p>
            ) : null}
          </div>
          {ready ? (
            <Switch
              checked={allowed}
              disabled={disabled}
              aria-label={CREDENTIAL_EXPORT_TOGGLE_LABEL}
              data-testid="org-credential-export-toggle"
              onCheckedChange={(checked) => {
                if (checked) {
                  save("allow");
                  return;
                }
                // Every member's local runs stop at their next connect: ask.
                setConfirmingOff(true);
              }}
            />
          ) : (
            // Never an unchecked switch for a value nobody knows yet.
            <Skeleton
              className="h-5 w-9 rounded-full"
              data-testid="org-credential-export-toggle-loading"
            />
          )}
        </div>

        <p className="text-xs text-muted-foreground">{DELIVERED_NOTE}</p>

        {showConfirmOff ? (
          <div
            role="group"
            aria-labelledby="org-credential-export-confirm-off-title"
            className="space-y-3 rounded-md border border-border px-3 py-3"
            data-testid="org-credential-export-confirm-off"
          >
            <div className="space-y-1">
              <p
                id="org-credential-export-confirm-off-title"
                className="text-sm font-medium"
              >
                Turn off &ldquo;{CREDENTIAL_EXPORT_TOGGLE_LABEL}&rdquo;?
              </p>
              <p className="text-xs text-muted-foreground">
                Members&apos; local apps, the CLI and sandboxes stop receiving
                saved credentials at their next request, and the change is
                recorded in the audit log. Tokens they already have keep working
                until they expire.
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={isSaving}
                onClick={() => setConfirmingOff(false)}
              >
                Keep it on
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={isSaving}
                onClick={() => save("deny")}
                data-testid="org-credential-export-confirm-off-button"
              >
                Turn off
              </Button>
            </div>
          </div>
        ) : null}

        {!isAdmin && ready ? (
          <p className="text-xs text-muted-foreground">
            Only organization owners and admins can change this.
          </p>
        ) : null}
        {isLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
