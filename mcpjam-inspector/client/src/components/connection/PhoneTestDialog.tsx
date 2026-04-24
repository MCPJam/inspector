import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";
import { QRCodeSVG } from "qrcode.react";
import {
  Check,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  Smartphone,
  TriangleAlert,
} from "lucide-react";

interface PhoneTestDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  serverName: string;
  shareUrl: string | null;
  isPreparing: boolean;
  statusMessage: string;
  errorMessage: string | null;
  isCopied: boolean;
  onCopyLink: () => void;
  onOpenLink: () => void;
  onRetry: () => void;
}

export function PhoneTestDialog({
  isOpen,
  onOpenChange,
  serverName,
  shareUrl,
  isPreparing,
  statusMessage,
  errorMessage,
  isCopied,
  onCopyLink,
  onOpenLink,
  onRetry,
}: PhoneTestDialogProps) {
  const hasReadyLink = typeof shareUrl === "string" && shareUrl.trim() !== "";

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader className="gap-1.5 text-left">
          <DialogTitle>
            Test &ldquo;{serverName}&rdquo; on your phone
          </DialogTitle>
          <DialogDescription>
            Reuse the existing share page. We&apos;ll point it at this
            machine&apos;s tunnel and rotate a fresh link for quick mobile
            testing.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {isPreparing ? (
            <div className="rounded-2xl border border-border/60 bg-muted/30 px-5 py-8 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-border/60 bg-background/90 shadow-sm">
                <Loader2 className="h-5 w-5 animate-spin text-foreground" />
              </div>
              <p className="mt-4 text-sm font-medium text-foreground">
                {statusMessage}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Creating or reusing the tunnel, syncing the hosted server, and
                rotating a fresh share link.
              </p>
            </div>
          ) : errorMessage ? (
            <div className="rounded-2xl border border-amber-300/60 bg-amber-500/10 px-4 py-4">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-full bg-background/90 text-amber-700 shadow-sm dark:text-amber-300">
                  <TriangleAlert className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">
                    Phone test link unavailable
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {errorMessage}
                  </p>
                </div>
              </div>
            </div>
          ) : hasReadyLink ? (
            <>
              <div className="rounded-2xl border border-border/60 bg-gradient-to-b from-background via-background to-muted/20 px-4 py-5 shadow-sm">
                <div className="mx-auto flex w-full max-w-[280px] items-center justify-center rounded-[28px] border border-border/60 bg-white p-4 shadow-sm">
                  <div
                    data-testid="phone-test-qr"
                    data-share-url={shareUrl}
                    className="rounded-2xl"
                  >
                    <QRCodeSVG
                      aria-label={`QR code for ${serverName} phone test link`}
                      includeMargin
                      size={224}
                      value={shareUrl}
                    />
                  </div>
                </div>
                <div className="mt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Smartphone className="h-3.5 w-3.5" />
                  <span>
                    Scan with your phone camera or open the link directly.
                  </span>
                </div>
              </div>

              <div className="rounded-2xl border border-border/60 bg-muted/30 p-3">
                <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  Share Link
                </p>
                <p className="mt-2 break-all font-mono text-xs leading-5 text-foreground">
                  {shareUrl}
                </p>
              </div>
            </>
          ) : null}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Button
            variant="outline"
            onClick={onRetry}
            disabled={isPreparing}
            className="w-full sm:w-auto"
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            {hasReadyLink ? "Rotate link" : "Try again"}
          </Button>

          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <Button
              variant="outline"
              onClick={onCopyLink}
              disabled={!hasReadyLink || isPreparing}
              className="w-full sm:w-auto"
            >
              {isCopied ? (
                <Check className="mr-2 h-4 w-4" />
              ) : (
                <Copy className="mr-2 h-4 w-4" />
              )}
              {isCopied ? "Copied" : "Copy link"}
            </Button>
            <Button
              onClick={onOpenLink}
              disabled={!hasReadyLink || isPreparing}
              className="w-full sm:w-auto"
            >
              <ExternalLink className="mr-2 h-4 w-4" />
              Open link
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
