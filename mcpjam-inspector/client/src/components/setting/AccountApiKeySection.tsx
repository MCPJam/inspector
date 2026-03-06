import { Check, Copy, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";

type CopyFieldProps = {
  value: string;
  isCopied: boolean;
  onCopy: () => void;
  copyLabel: string;
  tooltip?: string;
};

function ApiKeyCopyField({
  value,
  isCopied,
  onCopy,
  copyLabel,
  tooltip = "Copy to clipboard",
}: CopyFieldProps) {
  return (
    <div className="relative w-full">
      <Input
        readOnly
        value={value}
        className="h-12 w-full rounded-lg border border-border/40 bg-background/50 font-mono text-sm tracking-wide text-foreground pr-16 shadow-sm focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary/20"
        style={{
          fontFamily:
            'ui-monospace, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace',
        }}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            onClick={onCopy}
            className="absolute right-3 top-3 h-6 w-6 p-0 rounded-md border-0 bg-transparent text-foreground/60 hover:text-foreground hover:bg-foreground/10 transition-all duration-200"
          >
            {isCopied ? (
              <Check className="h-4 w-4" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{tooltip}</TooltipContent>
      </Tooltip>
    </div>
  );
}

type AccountApiKeySectionProps = {
  workspaceId: string | null;
  workspaceName: string | null;
};

export function AccountApiKeySection({
  workspaceId,
  workspaceName,
}: AccountApiKeySectionProps) {
  const [apiKeyPlaintext, setApiKeyPlaintext] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isApiKeyModalOpen, setIsApiKeyModalOpen] = useState(false);

  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const { signIn } = useAuth();
  const posthog = usePostHog();

  const maybeApiKey = useQuery(
    "apiKeys:list" as any,
    workspaceId ? ({ workspaceId } as any) : "skip",
  ) as
    | {
        _id: string;
        workspaceId?: string;
        name: string;
        prefix: string;
        createdAt: number;
        lastUsedAt: number | null;
        revokedAt: number | null;
      }[]
    | undefined;

  const regenerateAndGet = useMutation(
    "apiKeys:regenerateAndGet" as any,
  ) as unknown as (args: { workspaceId?: string }) => Promise<{
    apiKey: string;
    key: {
      _id: string;
      workspaceId?: string;
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

  const handleGenerate = async () => {
    if (!isAuthenticated || !workspaceId) return false;
    try {
      setIsGenerating(true);
      setIsCopied(false);
      const result = await regenerateAndGet({ workspaceId });
      setApiKeyPlaintext(result.apiKey);
      setIsApiKeyModalOpen(true);
      return true;
    } catch (err) {
      console.error("Failed to generate key", err);
      return false;
    } finally {
      setIsGenerating(false);
    }
  };

  if (isAuthLoading) {
    return (
      <div className="flex items-center justify-between px-4 py-3 rounded-md border border-border/40">
        <span className="text-sm text-muted-foreground">Workspace API Key</span>
        <span className="text-sm text-muted-foreground">Checking…</span>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-between px-4 py-3 rounded-md border border-border/40">
        <span className="text-sm text-muted-foreground">Workspace API Key</span>
        <Button
          type="button"
          onClick={() => {
            posthog.capture("login_button_clicked", {
              location: "account_api_key_section",
              platform: detectPlatform(),
              environment: detectEnvironment(),
            });
            signIn();
          }}
          size="sm"
        >
          Sign in
        </Button>
      </div>
    );
  }

  if (!workspaceId) {
    return (
      <div className="flex items-center justify-between px-4 py-3 rounded-md border border-border/40">
        <span className="text-sm text-muted-foreground">
          Select a workspace to manage API keys.
        </span>
      </div>
    );
  }

  const activeKeys = maybeApiKey?.filter((k) => !k.revokedAt);
  const existingKey =
    activeKeys && activeKeys.length > 0 ? activeKeys[0] : null;

  const rightSide = (() => {
    if (maybeApiKey === undefined) {
      return <span className="text-sm text-muted-foreground">Loading…</span>;
    }
    if ((activeKeys?.length ?? 0) === 0 && !apiKeyPlaintext) {
      return (
        <Button
          type="button"
          onClick={() => {
            void handleGenerate();
          }}
          disabled={isGenerating}
          size="sm"
        >
          {isGenerating ? "Generating…" : "Generate API key"}
        </Button>
      );
    }
    return (
      <div className="flex items-center gap-3">
        {existingKey && (
          <span className="font-mono text-xs text-muted-foreground">
            mcpjam_{existingKey.prefix}_{"••••••••"}
          </span>
        )}
        <AlertDialog open={isConfirmOpen} onOpenChange={setIsConfirmOpen}>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="outline"
              disabled={isGenerating}
              size="sm"
              className="gap-1.5"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${isGenerating ? "animate-spin" : ""}`}
              />
              {isGenerating ? "Regenerating…" : "Regenerate"}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="text-lg font-semibold">
                Regenerate Workspace API Key?
              </AlertDialogTitle>
              <AlertDialogDescription className="text-sm text-muted-foreground leading-relaxed">
                This will immediately invalidate your current API key. Any
                integrations or services using the existing key will stop
                working. This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="gap-3">
              <AlertDialogCancel
                disabled={isGenerating}
                className="font-medium"
              >
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={async (event) => {
                  event.preventDefault();
                  const success = await handleGenerate();
                  if (success) {
                    setIsConfirmOpen(false);
                  }
                }}
                disabled={isGenerating}
                className="font-medium"
              >
                {isGenerating ? "Regenerating…" : "Regenerate"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  })();

  return (
    <>
      <div className="flex items-center justify-between px-4 py-3 rounded-md border border-border/40">
        <div className="flex flex-col">
          <span className="text-sm text-muted-foreground">
            Workspace API Key
            {workspaceName ? ` · ${workspaceName}` : ""}
          </span>
          <span className="text-muted-foreground text-xs">
            Shared with all workspace members.
          </span>
        </div>
        <span className="text-sm">{rightSide}</span>
      </div>
      <Dialog
        open={Boolean(apiKeyPlaintext) && isApiKeyModalOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsCopied(false);
            setApiKeyPlaintext(null);
          }
          setIsApiKeyModalOpen(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API Key</DialogTitle>
            <DialogDescription>
              {workspaceName
                ? `This key belongs to ${workspaceName}. Copy and store it securely. You will not be able to view it again.`
                : "Copy and store this key securely. You will not be able to view it again."}
            </DialogDescription>
          </DialogHeader>
          <ApiKeyCopyField
            value={apiKeyPlaintext ?? ""}
            isCopied={isCopied}
            onCopy={handleCopyPlaintext}
            copyLabel="Copy"
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
