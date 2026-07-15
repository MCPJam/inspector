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
import {
  type ApiKey,
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "@/lib/apis/web/api-keys";
import { writeApiKeysSignInReturnPath } from "@/lib/api-keys-signin-return-path";
import { SettingsNav } from "./SettingsNav";

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
}

export function ApiKeysRoute({ activeOrganizationId }: ApiKeysRouteProps = {}) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [revealValue, setRevealValue] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);

  const { isAuthenticated } = useConvexAuth();
  // Guests authenticate to Convex too, so gate this surface on the WorkOS
  // user: the key-management API rejects guest sessions outright.
  const { user, signIn, isLoading: isAuthLoading } = useAuth();
  const isSignedIn = Boolean(user);
  const { sortedOrganizations, isLoading: orgsLoading } =
    useOrganizationQueries({ isAuthenticated });

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const items = await listApiKeys();
      setKeys(items);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load API keys";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isSignedIn) return;
    void refresh();
  }, [refresh, isSignedIn]);

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
    setIsCreating(true);
    try {
      const created = await createApiKey({ name, organizationId });
      setCreateOpen(false);
      setRevealValue(created.value);
      await refresh();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create API key";
      toast.error(message);
      throw error;
    } finally {
      setIsCreating(false);
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setIsRevoking(true);
    try {
      await revokeApiKey(revokeTarget.id);
      toast.success(`Revoked ${revokeTarget.name}`);
      setRevokeTarget(null);
      await refresh();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to revoke API key";
      toast.error(message);
      throw error;
    } finally {
      setIsRevoking(false);
    }
  };

  if (isAuthLoading) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <div className="text-center space-y-4 max-w-md">
          <h2 className="text-2xl font-bold">Sign in to manage API keys</h2>
          <p className="text-sm text-muted-foreground">
            API keys for the MCPJam API are tied to your account. Sign in (or
            create a free account) and you'll come right back here to create
            one.
          </p>
          <Button onClick={handleSignIn} size="lg">
            Sign In
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-10 space-y-8 max-w-3xl">
        <div className="space-y-4">
          <h1 className="text-2xl font-semibold">Settings</h1>
          <SettingsNav
            active="api-keys"
            activeOrganizationId={activeOrganizationId}
          />
        </div>

        <div className="flex items-start justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            Use these keys to call the MCPJam v1 public API from CI, scripts, or
            other non-browser contexts. Keys carry your account's permissions
            and can be revoked any time.
          </p>
          <Button onClick={() => setCreateOpen(true)} className="shrink-0">
            <Plus className="mr-2 size-4" aria-hidden /> Create API key
          </Button>
        </div>

        <SettingsSection title="Your keys">
          {loading ? (
            <div className="flex items-center justify-center px-4 py-8 text-sm text-muted-foreground">
              Loading…
            </div>
          ) : keys.length === 0 ? (
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
                    <span className="text-xs text-muted-foreground font-mono truncate">
                      {key.obfuscated_value}
                    </span>
                  </div>
                </div>
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
      </div>
    </div>
  );
}
