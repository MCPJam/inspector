import { SettingsPageDescription } from "@/components/settings/SettingsPageDescription";
import { useCallback, useEffect, useState } from "react";
import { useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { Key, Plus, Trash2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@mcpjam/design-system/button";
import { SettingsSection } from "../setting/SettingsSection";
import { CreateApiKeyDialog } from "./api-keys/CreateApiKeyDialog";
import { RevealOnceDialog } from "./api-keys/RevealOnceDialog";
import { RevokeApiKeyDialog } from "./api-keys/RevokeApiKeyDialog";
import { useOrganizationQueries } from "@/hooks/useOrganizations";
import { useApiKeys } from "@/hooks/useApiKeys";
import { type ApiKey } from "@/lib/apis/web/api-keys";
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
 */
interface ApiKeysRouteProps {
  activeOrganizationId?: string | null;
  organizationId?: string;
}

export function ApiKeysRoute({ organizationId }: ApiKeysRouteProps = {}) {
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

  const handleCreate = async ({
    name,
    organizationId,
  }: {
    name: string;
    organizationId: string;
  }) => {
    try {
      const created = await create({ name, organizationId });
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
      toast.success(`Revoked ${target.name}`);
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
            ? "Review keys scoped to this organization and the users they belong to. Key owners manage revocation in Personal → API Keys."
            : "Create keys for scripts, CI/CD, CLI, and SDK usage. Each key belongs to you and uses your permissions within one selected organization."}
        </SettingsPageDescription>
      </header>
      {!organizationId && (
        <Button onClick={() => setCreateOpen(true)} className="self-start">
          <Plus className="mr-2 size-4" aria-hidden /> Create API key
        </Button>
      )}

      {loadError && (
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
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
            No API keys yet. Create one to start using the v1 API.
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
                    {key.name}
                  </span>
                  <span className="text-xs text-foreground">
                    {organizationId
                      ? `${key.owner?.name ?? "Unknown user"} · ${key.owner?.email ?? ""}`
                      : (sortedOrganizations.find(
                          (org) => org._id === key.organizationId,
                        )?.name ??
                        key.organizationId ??
                        "Organization unavailable")}
                  </span>
                  <span className="text-xs text-muted-foreground font-mono truncate">
                    {key.obfuscated_value}
                  </span>
                </div>
              </div>
              {!organizationId && (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => setRevokeTarget(key)}
                    aria-label={`Revoke ${key.name}`}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              )}
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
        keyName={revokeTarget?.name ?? ""}
        isRevoking={isRevoking}
        onConfirm={handleRevoke}
      />
    </SettingsPageShell>
  );
}
