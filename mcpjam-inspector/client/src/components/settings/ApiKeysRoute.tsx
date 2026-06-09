import { useCallback, useEffect, useState } from "react";
import { Key, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { SettingsSection } from "../setting/SettingsSection";
import { CreateApiKeyDialog } from "./api-keys/CreateApiKeyDialog";
import { RevealOnceDialog } from "./api-keys/RevealOnceDialog";
import { RevokeApiKeyDialog } from "./api-keys/RevokeApiKeyDialog";
import {
  type ApiKey,
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "@/lib/apis/web/api-keys";

/**
 * `/settings/api-keys` — manage WorkOS-issued `sk_…` API keys for the
 * v1 public API.
 *
 * Server side gates this surface: the inspector's `/api/web/api-keys/*`
 * sub-router refuses requests that themselves authenticated via a
 * `sk_…` key. That means visiting this page over a session JWT is the
 * only way to mint/revoke — there is no privilege escalation path here.
 */
export function ApiKeysRoute() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [revealValue, setRevealValue] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);

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
    void refresh();
  }, [refresh]);

  const handleCreate = async ({ name }: { name: string }) => {
    setIsCreating(true);
    try {
      const created = await createApiKey({ name });
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

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-10 space-y-8 max-w-3xl">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">API keys</h1>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 size-4" aria-hidden /> Create API key
          </Button>
        </div>

        <p className="text-sm text-muted-foreground">
          Use these keys to call the MCPJam v1 public API from CI, scripts, or
          other non-browser contexts. Keys carry your account's permissions
          and can be revoked any time.
        </p>

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
