import { SettingsPageDescription } from "@/components/settings/SettingsPageDescription";
import { useCallback, useEffect, useState } from "react";
import { useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { AlertTriangle, Clock, Key, Plus, Trash2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import { SettingsSection } from "../setting/SettingsSection";
import { CreateApiKeyDialog } from "./api-keys/CreateApiKeyDialog";
import { RevealOnceDialog } from "./api-keys/RevealOnceDialog";
import { RevokeApiKeyDialog } from "./api-keys/RevokeApiKeyDialog";
import { OrganizationApiKeyPolicyCard } from "../organization/OrganizationApiKeyPolicyCard";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { isConvexQueryUnavailable } from "@/lib/convex-error";
import { useOrganizationQueries } from "@/hooks/useOrganizations";
import { useApiKeys } from "@/hooks/useApiKeys";
import { type ApiKey } from "@/lib/apis/web/api-keys";
import { describeApiKeyExpiry } from "@/lib/api-key-expiry";
import { writeApiKeysSignInReturnPath } from "@/lib/api-keys-signin-return-path";
import { SettingsPageShell } from "./SettingsPageShell";
import { SettingsStatePanel } from "./SettingsStatePanel";

/**
 * `/settings/api-keys` — manage WorkOS-issued `sk_…` API keys for the
 * v1 public API.
 *
 * Server side gates this surface: the inspector's `/api/web/api-keys/*`
 * sub-router refuses requests that themselves authenticated via a
 * `sk_…` key. That means visiting this page over a session JWT is the
 * only way to mint/revoke — there is no privilege escalation path here.
 *
 * With `organizationId` it is the organization inventory instead: every key
 * bound to that org, who minted it, when it expires, and — for owners and
 * admins, who are the only ones the server lets load it — a revoke action on
 * each, plus the org's setting for who may create keys.
 */
interface ApiKeysRouteProps {
  organizationId?: string;
  /** Owner or admin of `organizationId`; enables the key creation setting. */
  isAdmin?: boolean;
}

/** A key's display name; the id stands in when WorkOS could not be asked. */
function keyLabel(key: ApiKey): string {
  return key.name ?? key.id;
}

function ownerLabel(key: ApiKey): string {
  return key.owner
    ? `${key.owner.name} · ${key.owner.email}`
    : "Unknown user (account removed)";
}

/**
 * When a key stops working. Anything other than a comfortably distant date is
 * flagged: expired, expiring within two weeks, or a key from before expiry
 * existed that never will unless someone revokes it.
 */
function KeyExpiry({ expiresAt }: { expiresAt?: string | null }) {
  const expiry = describeApiKeyExpiry(expiresAt);
  const expired = expiry.state === "expired";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs",
        expired ? "text-destructive" : "text-muted-foreground",
      )}
      data-testid="api-key-expiry"
      data-expiry-state={expiry.state}
    >
      {expiry.state === "active" ? (
        <Clock className="size-3 shrink-0" aria-hidden />
      ) : (
        <AlertTriangle
          className={cn(
            "size-3 shrink-0",
            expired ? "text-destructive" : "text-warning",
          )}
          aria-hidden
        />
      )}
      {expiry.label}
    </span>
  );
}

export function ApiKeysRoute({
  organizationId,
  isAdmin = false,
}: ApiKeysRouteProps = {}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [revealValue, setRevealValue] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);

  const { isAuthenticated } = useConvexAuth();
  // Guests authenticate to Convex too, so gate this surface on the WorkOS
  // user: the key-management API rejects guest sessions outright.
  const { user, signIn, isLoading: isAuthLoading } = useAuth();
  const isSignedIn = Boolean(user);
  const { sortedOrganizations, isLoading: orgsLoading } =
    useOrganizationQueries({ isAuthenticated });

  const {
    keys,
    truncated,
    loading,
    error: loadError,
    create,
    isCreating,
    revoke,
    isRevoking,
  } = useApiKeys({ enabled: isSignedIn, organizationId });

  // The hook RETURNS list errors so its other caller (the eval quickstart)
  // can render them inline; this page's behavior is unchanged — surface them
  // as the toast it always showed.
  useEffect(() => {
    if (loadError) toast.error(loadError);
  }, [loadError]);

  const handleSignIn = useCallback(() => {
    writeApiKeysSignInReturnPath("/settings/api-keys");
    signIn();
  }, [signIn]);

  const handleCreate = async (args: {
    name: string;
    organizationId: string;
    expiresInDays: number;
  }) => {
    try {
      const created = await create(args);
      setCreateOpen(false);
      setRevealValue(created.value);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create API key";
      toast.error(message);
      throw error;
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    const target = revokeTarget;
    try {
      await revoke(target.id);
      toast.success(`Revoked ${keyLabel(target)}`);
      setRevokeTarget(null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to revoke API key";
      toast.error(message);
      throw error;
    }
  };

  // Both gates keep the shell so the other Settings sections stay one click
  // away — replacing the page with a bare sign-in button strands the user.
  if (isAuthLoading) {
    return (
      <SettingsPageShell>
        <SettingsStatePanel>
          <span className="text-sm text-muted-foreground">Loading…</span>
        </SettingsStatePanel>
      </SettingsPageShell>
    );
  }

  if (!isSignedIn) {
    return (
      <SettingsPageShell>
        <SettingsStatePanel>
          <h2 className="text-lg font-semibold">Sign in to manage API keys</h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            API keys for the MCPJam API are tied to your account. Sign in (or
            create a free account) and you'll come right back here to create
            one.
          </p>
          <Button onClick={handleSignIn}>Sign in</Button>
        </SettingsStatePanel>
      </SettingsPageShell>
    );
  }

  return (
    <SettingsPageShell>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-accent-foreground">
          API keys
        </h1>
        <SettingsPageDescription>
          {organizationId
            ? "Review every key scoped to this organization, who it belongs to, and when it expires. Owners and admins can revoke any of them."
            : "Create keys for scripts, CI/CD, CLI, and SDK usage. Each key belongs to you, uses your permissions within one selected organization, and expires on the date you choose."}
        </SettingsPageDescription>
      </header>
      {!organizationId && (
        <Button onClick={() => setCreateOpen(true)} className="self-start">
          <Plus className="mr-2 size-4" aria-hidden /> Create API key
        </Button>
      )}

      {organizationId && (
        // A backend without the policy module throws from `useQuery`; hide
        // the setting then, rather than taking the key inventory down with it.
        <ErrorBoundary
          name="organization_api_key_policy"
          fallback={null}
          isExpectedError={isConvexQueryUnavailable}
        >
          <OrganizationApiKeyPolicyCard
            organizationId={organizationId}
            isAdmin={isAdmin}
          />
        </ErrorBoundary>
      )}

      {loadError && (
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      )}
      {organizationId && truncated && !loadError && (
        <div
          role="status"
          data-testid="api-keys-truncated"
          className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-foreground"
        >
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0 text-warning"
            aria-hidden
          />
          <p>
            This organization has more API keys than this page can list, so some
            are not shown. Revoking keys you no longer need brings the rest into
            view.
          </p>
        </div>
      )}
      <SettingsSection
        title={organizationId ? "Organization keys" : "Your keys"}
      >
        {loading ? (
          <div className="flex items-center justify-center px-4 py-8 text-sm text-muted-foreground">
            Loading…
          </div>
        ) : loadError ? null : keys.length === 0 ? (
          <div className="flex items-center justify-center px-4 py-8 text-sm text-muted-foreground">
            {organizationId
              ? "This organization has no API keys."
              : "No API keys yet. Create one to start using the v1 API."}
          </div>
        ) : (
          keys.map((key) => (
            <div
              key={key.id}
              className="flex items-center justify-between px-4 py-3 rounded-md border border-border/40 bg-muted/20 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="size-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                  <Key className="size-4 text-primary" aria-hidden />
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="text-sm font-medium truncate">
                    {key.name ?? "Unnamed key"}
                  </span>
                  <span
                    className={cn(
                      "text-xs",
                      organizationId && !key.owner
                        ? "text-muted-foreground italic"
                        : "text-foreground",
                    )}
                  >
                    {organizationId
                      ? ownerLabel(key)
                      : (sortedOrganizations.find(
                          (org) => org._id === key.organizationId,
                        )?.name ??
                        key.organizationId ??
                        "Organization unavailable")}
                  </span>
                  <span className="text-xs text-muted-foreground font-mono truncate">
                    {key.obfuscated_value ?? key.id}
                  </span>
                  <KeyExpiry expiresAt={key.expires_at} />
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => setRevokeTarget(key)}
                  aria-label={`Revoke ${keyLabel(key)}`}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          ))
        )}
      </SettingsSection>

      <CreateApiKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        isCreating={isCreating}
        organizations={sortedOrganizations}
        orgsLoading={orgsLoading}
        onCreate={handleCreate}
      />

      <RevealOnceDialog
        open={revealValue !== null}
        onOpenChange={(next) => {
          if (!next) setRevealValue(null);
        }}
        value={revealValue}
      />

      <RevokeApiKeyDialog
        open={revokeTarget !== null}
        onOpenChange={(next) => {
          if (!next) setRevokeTarget(null);
        }}
        keyName={revokeTarget ? keyLabel(revokeTarget) : ""}
        ownerLabel={
          organizationId ? (revokeTarget?.owner?.name ?? undefined) : undefined
        }
        isRevoking={isRevoking}
        onConfirm={handleRevoke}
      />
    </SettingsPageShell>
  );
}
