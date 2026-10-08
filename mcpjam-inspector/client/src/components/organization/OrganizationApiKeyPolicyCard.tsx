import { Card, CardContent, CardHeader } from "@mcpjam/design-system/card";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import { Switch } from "@mcpjam/design-system/switch";
import { useOrgApiKeyPolicy } from "@/hooks/useOrgApiKeyPolicy";

/**
 * Who may create API keys bound to this organization.
 *
 * On (the default, MJ-010) keeps creating keys to owners and admins. Off lets
 * any member create a key too, and each key only ever acts with its creator's
 * own permissions. Either way, keys that already exist keep working until they
 * expire or are revoked.
 */
export function OrganizationApiKeyPolicyCard({
  organizationId,
  isAdmin,
}: {
  organizationId: string;
  isAdmin: boolean;
}) {
  const { policy, isLoading, error, isSaving, setMintMinimumRole } =
    useOrgApiKeyPolicy(organizationId);
  const policyReady = policy !== undefined;
  const disabled = !isAdmin || isSaving || !policyReady;

  return (
    <Card
      className="gap-4 border-0 bg-transparent py-0 shadow-none"
      data-testid="org-api-key-policy-card"
    >
      <CardHeader className="px-0">
        <h2 className="text-sm font-medium text-muted-foreground">
          Key creation
        </h2>
      </CardHeader>
      <CardContent className="space-y-3 p-0">
        {error ? (
          <Alert variant="destructive" data-testid="org-api-key-policy-error">
            <AlertTitle>Couldn&apos;t save the key creation setting</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">
              Only owners and admins can create keys
            </p>
            <p className="text-xs text-muted-foreground">
              On by default. Turn it off to let any member create keys that act
              with their own permissions. Existing keys keep working until they
              expire or are revoked.
            </p>
          </div>
          <Switch
            checked={policy?.mintMinimumRole === "admin"}
            disabled={disabled}
            aria-label="Only owners and admins can create keys"
            data-testid="org-api-key-policy-admins-only"
            onCheckedChange={(checked) => {
              if (!policyReady) return;
              void setMintMinimumRole(checked ? "admin" : "member").catch(
                () => {},
              );
            }}
          />
        </div>

        {!isAdmin ? (
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
