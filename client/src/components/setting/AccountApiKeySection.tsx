import { KeyRound, Copy, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { api } from "../../../../convex/_generated/api";

export function AccountApiKeySection() {
  const [apiKeyPlaintext, setApiKeyPlaintext] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const { signIn } = useAuth();

  const anyApi = api as any;
  const keys = useQuery(
    anyApi.apiKeys.list,
    isAuthenticated ? {} : undefined,
  ) as
    | {
        _id: string;
        name: string;
        prefix: string;
        createdAt: number;
        lastUsedAt: number | null;
        revokedAt: number | null;
      }[]
    | undefined;
  const createOrUpdate = useMutation(
    anyApi.apiKeys.createOrUpdate,
  ) as unknown as (
    args: { name?: string; forceNew?: boolean },
  ) => Promise<
    | {
        created: true;
        updated: false;
        apiKey: string;
        key: {
          _id: string;
          prefix: string;
          name: string;
          createdAt: number;
          lastUsedAt: number | null;
          revokedAt: number | null;
        };
      }
    | {
        created: false;
        updated: boolean;
        apiKey: null;
        key: {
          _id: string;
          prefix: string;
          name: string;
          createdAt: number;
          lastUsedAt: number | null;
          revokedAt: number | null;
        };
      }
  >;

  const primaryKey = (keys ?? []).find((k) => !k.revokedAt) ?? null;

  const handleGenerateKey = async (forceNew: boolean) => {
    if (!isAuthenticated) return;
    try {
      setIsGenerating(true);
      const result = await createOrUpdate({ forceNew });
      setApiKeyPlaintext(result.apiKey);
    } catch (err) {
      console.error("Failed to generate key", err);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopyPlaintext = async () => {
    if (!apiKeyPlaintext) return;
    try {
      await navigator.clipboard.writeText(apiKeyPlaintext);
    } catch (err) {
      console.error("Clipboard error", err);
    }
  };

  if (isAuthLoading) {
    return (
      <div className="rounded-md border p-3 text-sm text-muted-foreground">
        Checking authentication…
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="space-y-3 rounded-md border p-4">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" />
          <h3 className="text-lg font-semibold">Account API Key</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          Sign in to view and manage your API key.
        </p>
        <Button type="button" onClick={() => signIn()} size="sm">
          Sign in
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <KeyRound className="h-5 w-5" />
        <h3 className="text-lg font-semibold">Account API Key</h3>
      </div>
      <p className="text-muted-foreground text-sm">
        Generate and manage your personal API key for authenticated requests.
        The full key is shown only once when created.
      </p>

      {primaryKey ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <div className="text-sm text-muted-foreground">Key prefix</div>
            <div className="font-mono text-sm">{primaryKey.prefix}</div>
          </div>
          <div className="space-y-1">
            <div className="text-sm text-muted-foreground">Created</div>
            <div className="text-sm">
              {new Date(primaryKey.createdAt).toLocaleString()}
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-sm text-muted-foreground">Last used</div>
            <div className="text-sm">
              {primaryKey.lastUsedAt
                ? new Date(primaryKey.lastUsedAt).toLocaleString()
                : "Never"}
            </div>
          </div>
          <div className="flex items-end justify-start">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => handleGenerateKey(true)}
              disabled={isGenerating || !isAuthenticated}
            >
              <RefreshCw className="h-4 w-4" />
              <span>Regenerate key</span>
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <Button
            type="button"
            onClick={() => handleGenerateKey(true)}
            disabled={isGenerating || !isAuthenticated}
          >
            <KeyRound className="h-4 w-4" />
            <span>Create API Key</span>
          </Button>
          <span className="text-sm text-muted-foreground">
            You don't have an active key yet.
          </span>
        </div>
      )}

      {apiKeyPlaintext ? (
        <div className="space-y-2 rounded-md border p-3">
          <div className="text-sm font-medium">Your new API key (shown once)</div>
          <div className="flex items-center gap-2">
            <Input readOnly value={apiKeyPlaintext} className="font-mono" />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCopyPlaintext}
            >
              <Copy className="h-4 w-4" />
              <span>Copy</span>
            </Button>
          </div>
          <div className="text-xs text-muted-foreground">
            Store this key securely. You won't be able to see it again.
          </div>
        </div>
      ) : null}
    </div>
  );
}


