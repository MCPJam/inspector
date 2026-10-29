import { Button } from "@mcpjam/design-system/button";
import { Pencil } from "lucide-react";
import type { ServerAuth } from "./server-auth";
import { AUTH_METHOD_LABELS } from "./shared/auth-method-labels";

interface ServerAuthSummaryProps {
  auth: ServerAuth;
  /** Switches the modal to the Config tab, where auth is edited. */
  onEditInConfig: () => void;
}

function methodNote(auth: ServerAuth): string {
  switch (auth.method) {
    case "bearer":
      return "Sends the saved token in the Authorization header.";
    case "none":
      return auth.headers
        ? "Sends only the custom headers below."
        : "Sends requests without credentials.";
    case "auto":
      return "Connected without credentials. Switches to OAuth if the server asks for it.";
    case "oauth":
      return "Accounts, tokens and the last OAuth trace are below.";
    case "xaa":
      return "Gets access tokens from your identity provider when MCPJam connects.";
  }
}

/**
 * The read-only top of the Auth tab: which auth method the server uses and
 * where to change it. Every HTTP server gets one, so the tab is never blank for
 * servers that don't use OAuth.
 */
export function ServerAuthSummary({
  auth,
  onEditInConfig,
}: ServerAuthSummaryProps) {
  return (
    <div className="space-y-3 pt-2 text-xs">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium text-muted-foreground">
          Authentication
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-xs"
          onClick={onEditInConfig}
        >
          <Pencil className="h-3 w-3" />
          Edit in Config
        </Button>
      </div>
      <div className="space-y-3 rounded-md bg-muted/40 p-3">
        <div className="space-y-0.5">
          <div className="text-sm font-medium text-foreground">
            {AUTH_METHOD_LABELS[auth.method]}
          </div>
          <p className="text-muted-foreground">{methodNote(auth)}</p>
        </div>
      </div>
    </div>
  );
}
