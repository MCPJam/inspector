import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Badge } from "@mcpjam/design-system/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
import { useHostedOAuthConnections } from "@/hooks/use-hosted-oauth-connections";
import { updateOAuthConnection } from "@/lib/apis/web/oauth-connections";
import {
  connectionLabel,
  type ConnectionIntent,
  type OAuthConnection,
} from "@/shared/oauth-connections";
export function ConnectionAccountsSection({
  projectId,
  serverId,
  enabled,
  onAuthenticate,
  onSwitch,
}: {
  projectId?: string | null;
  serverId?: string | null;
  enabled: boolean;
  onAuthenticate: (intent: ConnectionIntent) => void | Promise<void>;
  onSwitch: () => void | Promise<void>;
}) {
  const { connections, shared, error } = useHostedOAuthConnections(
    projectId,
    serverId,
    enabled,
  );
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<OAuthConnection>();
  if (!enabled || !projectId || !serverId) return null;
  const update = async (
    c: OAuthConnection,
    operation: "label" | "default" | "delete",
    label?: string,
  ) => {
    setBusy(true);
    try {
      await updateOAuthConnection(
        projectId,
        serverId,
        c.connectionId,
        operation,
        label,
      );
      if (operation === "default" || operation === "delete") await onSwitch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update account");
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="mt-3 text-xs" onClick={(e) => e.stopPropagation()}>
      <summary className="cursor-pointer py-1 font-medium">
        {connections.length} {connections.length === 1 ? "account" : "accounts"}
      </summary>
      <div className="space-y-3 pt-2">
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {connections.map((c, i) => (
          <div key={c.connectionId} className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <Input
                key={`${c.connectionId}:${c.label ?? ""}`}
                aria-label={`Label for ${connectionLabel(c, i)}`}
                defaultValue={c.label ?? ""}
                placeholder={connectionLabel(c, i)}
                maxLength={64}
                disabled={busy}
                onBlur={(e) => {
                  if (e.target.value !== (c.label ?? ""))
                    void update(c, "label", e.target.value);
                }}
              />
              {(c.profile?.email || c.profile?.name) && (
                <p className="mt-1 truncate text-muted-foreground">
                  {c.profile.email ?? c.profile.name}
                </p>
              )}
              {c.needsReauth && (
                <p className="mt-1 text-destructive">Needs reconnect</p>
              )}
            </div>
            {c.isDefault && <Badge variant="outline">Default</Badge>}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={busy}
                  aria-label={`Manage ${connectionLabel(c, i)}`}
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() =>
                    void onAuthenticate({
                      kind: "replace",
                      credentialId: c.connectionId,
                    })
                  }
                >
                  Reconnect
                </DropdownMenuItem>
                {!c.isDefault && (
                  <DropdownMenuItem
                    disabled={c.needsReauth}
                    onSelect={() => void update(c, "default")}
                  >
                    Use in chat / Set default
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => setRemoving(c)}>
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
        {!shared && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || connections.length >= 8}
            onClick={() => void onAuthenticate({ kind: "add" })}
          >
            Connect another account
          </Button>
        )}
      </div>
      <AlertDialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this account?</AlertDialogTitle>
            <AlertDialogDescription>
              MCPJam will remove this connection and its stored credentials.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (removing) void update(removing, "delete");
                setRemoving(undefined);
              }}
            >
              Remove account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </details>
  );
}
