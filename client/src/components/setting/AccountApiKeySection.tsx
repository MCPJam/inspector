import { KeyRound, Copy, RefreshCw, Eye, Check } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";

export function AccountApiKeySection() {
  const [apiKeyPlaintext, setApiKeyPlaintext] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const { signIn } = useAuth();

  const keys = useQuery(
    "apiKeys:list" as any,
    isAuthenticated ? ({} as any) : undefined,
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

  const regenerateAndGet = useMutation(
    "apiKeys:regenerateAndGet" as any,
  ) as unknown as () => Promise<{
    apiKey: string;
    key: {
      _id: string;
      prefix: string;
      name: string;
      createdAt: number;
      lastUsedAt: number | null;
      revokedAt: number | null;
    };
  }>;

  // We no longer need the primary key details for this simplified UI

  const handleCopyPlaintext = async () => {
    if (!apiKeyPlaintext) return;
    try {
      await navigator.clipboard.writeText(apiKeyPlaintext);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
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
          <h3 className="text-lg font-semibold">MCPJam API Key</h3>
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
        <h3 className="text-lg font-semibold">MCPJam API Key</h3>
      </div>
      <p className="text-muted-foreground text-sm">
        Manage your personal API key. You can show or regenerate it anytime.
      </p>

      <div className="space-y-2 rounded-md border p-3">
        <div className="text-sm font-medium">Your API key</div>
        <div className="flex items-center gap-2">
          <Input
            readOnly
            value={isVisible && apiKeyPlaintext ? apiKeyPlaintext : ""}
            placeholder="************************"
            className="font-mono"
          />
          <Button
            type="button"
            variant={isVisible ? "default" : "default"}
            size="sm"
            onClick={async () => {
              if (isVisible) {
                setIsVisible(false);
              } else {
                if (!apiKeyPlaintext && keys && keys.length > 0) {
                  try {
                    setIsGenerating(true);
                    const result = await regenerateAndGet();
                    setApiKeyPlaintext(result.apiKey);
                  } catch (err) {
                    console.error("Failed to get key", err);
                  } finally {
                    setIsGenerating(false);
                  }
                }
                setIsVisible(true);
              }
            }}
            disabled={
              isGenerating || (!apiKeyPlaintext && (!keys || keys.length === 0))
            }
            title={isVisible ? "Hide key" : "Show key"}
          >
            <Eye className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCopyPlaintext}
          >
            {isCopied ? (
              <>
                <Check className="h-4 w-4" />
                <span>Copied!</span>
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" />
                <span>Copy</span>
              </>
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={async () => {
              if (!isAuthenticated) return;
              try {
                setIsGenerating(true);
                const result = await regenerateAndGet();
                setApiKeyPlaintext(result.apiKey);
                setIsVisible(true);
              } catch (err) {
                console.error("Failed to regenerate key", err);
              } finally {
                setIsGenerating(false);
              }
            }}
            disabled={isGenerating || !isAuthenticated}
            title="Regenerate key"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
