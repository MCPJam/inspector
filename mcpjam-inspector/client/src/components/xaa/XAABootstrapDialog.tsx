import { Copy } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { HOSTED_MODE } from "@/lib/config";
import { copyToClipboard } from "@/lib/clipboard";

interface XAABootstrapDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function getIssuerBaseUrl(): string {
  if (typeof window === "undefined") {
    return HOSTED_MODE ? "/api/web/xaa" : "/api/mcp/xaa";
  }
  return `${window.location.origin}${HOSTED_MODE ? "/api/web/xaa" : "/api/mcp/xaa"}`;
}

function CopyRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex items-stretch gap-2">
        <div className="min-w-0 flex-1 rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs break-all">
          {value}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => copyToClipboard(value)}
          aria-label={`Copy ${label}`}
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

export function XAABootstrapDialog({
  open,
  onOpenChange,
}: XAABootstrapDialogProps) {
  const issuerBaseUrl = getIssuerBaseUrl();
  const jwksUrl = `${issuerBaseUrl}/.well-known/jwks.json`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Register MCPJam as an identity issuer</DialogTitle>
          <DialogDescription>
            The target authorization server must trust this inspector before
            the JWT-bearer token exchange can succeed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <CopyRow label="Issuer URL" value={issuerBaseUrl} />
          <CopyRow label="JWKS URL" value={jwksUrl} />

          <ol className="list-decimal space-y-1.5 pt-1 pl-5 text-xs text-muted-foreground marker:text-muted-foreground">
            <li>
              Register the issuer (or JWKS URL) with your authorization server.
            </li>
            <li>
              Set the ID-JAG <code className="font-mono">aud</code> to the
              authorization server issuer.
            </li>
            <li>
              Set the ID-JAG <code className="font-mono">resource</code> to the
              MCP server resource identifier.
            </li>
            <li>
              Register MCPJam with the authorization server using the client ID
              from your config.
            </li>
          </ol>

          {!HOSTED_MODE && (
            <p className="text-xs text-muted-foreground">
              Local URLs only work if the authorization server can reach this
              machine (e.g. via a public tunnel).
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
