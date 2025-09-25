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
import { format, formatDistanceToNow } from "date-fns";

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

export function AccountApiKeySection() {
  const [apiKeyPlaintext, setApiKeyPlaintext] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isApiKeyModalOpen, setIsApiKeyModalOpen] = useState(false);

  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const { signIn } = useAuth();

  const maybeApiKey = useQuery("apiKeys:list" as any) as
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

  const handleGenerate = async () => {
    if (!isAuthenticated) return false;
    try {
      setIsGenerating(true);
      setIsCopied(false);
      const result = await regenerateAndGet();
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
      <div className="rounded-md border p-3 text-sm text-muted-foreground">
        Checking authentication…
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="space-y-3 rounded-md border p-4">
        <div className="flex items-center gap-2">
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

  const existingKey =
    maybeApiKey && maybeApiKey.length > 0 ? maybeApiKey[0] : null;

  const describeTimestamp = (
    timestamp: number | null,
    emptyLabel = "Never",
  ) => {
    if (!timestamp) return emptyLabel;
    const date = new Date(timestamp);
    const relative = formatDistanceToNow(date, { addSuffix: true });
    return `${format(date, "PP p")} · ${relative}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h3 className="text-lg font-semibold">MCPJam API Key</h3>
      </div>
      {maybeApiKey === undefined ? (
        <p className="text-sm text-muted-foreground">Loading API key status…</p>
      ) : apiKeyPlaintext ? (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Copy and save this key now. You won't be able to view it again
            later.
          </p>
          <ApiKeyCopyField
            value={apiKeyPlaintext}
            isCopied={isCopied}
            onCopy={handleCopyPlaintext}
            copyLabel="Copy key"
          />
        </div>
      ) : (maybeApiKey?.length ?? 0) === 0 ? (
        <div className="space-y-4">
          <Button
            type="button"
            onClick={() => {
              void handleGenerate();
            }}
            disabled={isGenerating}
          >
            {isGenerating ? "Generating…" : "Generate API key"}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <AlertDialog open={isConfirmOpen} onOpenChange={setIsConfirmOpen}>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isGenerating}
                  className="inline-flex items-center gap-2.5 rounded-lg border border-border/50 bg-background px-4 py-2.5 text-sm font-medium text-foreground/80 hover:border-border hover:bg-background/80 hover:text-foreground transition-all duration-200"
                >
                  <RefreshCw
                    className={`h-4 w-4 ${isGenerating ? "animate-spin" : ""} text-foreground/60`}
                  />
                  <span>{isGenerating ? "Regenerating…" : "Regenerate"}</span>
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-lg font-semibold">
                    Confirm
                  </AlertDialogTitle>
                  <AlertDialogDescription className="text-sm text-muted-foreground leading-relaxed">
                    Regenerating an API key will replace your previous API key.
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
          {existingKey ? (
            <div className="rounded-lg border border-border/30 bg-background/50 p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium text-foreground/50 uppercase tracking-wide">
                    Created
                  </span>
                  <span className="text-xs text-foreground/70">
                    {describeTimestamp(existingKey.createdAt)}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium text-foreground/50 uppercase tracking-wide">
                    Last Used
                  </span>
                  <span className="text-xs text-foreground/70">
                    {describeTimestamp(existingKey.lastUsedAt, "Never used")}
                  </span>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}
      <Dialog
        open={Boolean(apiKeyPlaintext) && isApiKeyModalOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsCopied(false);
          }
          setIsApiKeyModalOpen(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API Key</DialogTitle>
            <DialogDescription>
              Copy and store this key securely. You will not be able to view it
              again.
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
    </div>
  );
}
