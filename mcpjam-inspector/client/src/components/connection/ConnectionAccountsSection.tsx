import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
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
import { useMultiAccountConnectionsEnabled } from "@/hooks/useMultiAccountConnectionsEnabled";
import {
  type ConnectionIntent,
  type OAuthConnection,
} from "@/shared/oauth-connections";

/**
 * The account a credential reaches, named the way the server named it, with
 * anything the user renamed it to underneath — two lines carrying two
 * different facts. They used to carry the same one: the row's editable field
 * fell back to the profile email and the line under it WAS the profile email,
 * so an unlabelled account printed its address twice.
 */
function identityOf(connection: OAuthConnection, index: number): string {
  const profile = connection.profile;
  return (
    profile?.email ||
    profile?.name ||
    profile?.nickname ||
    `Account ${index + 1}`
  );
}

/** The user's own words for this account, and whether chat uses it. */
function captionOf(
  connection: OAuthConnection,
  identity: string,
): string | undefined {
  if (connection.needsReauth) return undefined;
  const named = connection.label || connection.profile?.name;
  return (
    [named === identity ? undefined : named, connection.isDefault ? "Default" : null]
      .filter(Boolean)
      .join(" · ") || undefined
  );
}

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
  const canAddAccount = useMultiAccountConnectionsEnabled();
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string>();
  const renameRef = useRef<HTMLInputElement>(null);
  // Closing the menu hands focus back to the trigger, and that blur lands on
  // the rename field before it has ever held focus — which would close the
  // edit the instant it opened. The field takes focus a frame later, and a
  // blur that arrives before it was focused commits nothing.
  const renameHeldFocus = useRef(false);

  useEffect(() => {
    if (!renaming) return;
    renameHeldFocus.current = false;
    const frame = requestAnimationFrame(() => {
      renameRef.current?.focus();
      renameRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [renaming]);
  const [removing, setRemoving] = useState<OAuthConnection>();

  if (!enabled || !projectId || !serverId) return null;

  const update = async (
    connection: OAuthConnection,
    operation: "label" | "default" | "delete",
    label?: string,
  ) => {
    setBusy(true);
    try {
      await updateOAuthConnection(
        projectId,
        serverId,
        connection.connectionId,
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
    <div className="space-y-2 pt-2">
      <p className="text-xs font-medium text-muted-foreground">
        Connected accounts
      </p>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="space-y-1">
        {connections.map((connection, index) => {
          const identity = identityOf(connection, index);
          const caption = captionOf(connection, identity);
          return (
            <div
              key={connection.connectionId}
              className="flex items-center gap-3 rounded-lg px-1 py-1.5"
            >
              <span
                aria-hidden
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-medium text-secondary-foreground uppercase"
              >
                {identity.slice(0, 1)}
              </span>

              <div className="min-w-0 flex-1">
                {renaming === connection.connectionId ? (
                  <Input
                    ref={renameRef}
                    onFocus={() => {
                      renameHeldFocus.current = true;
                    }}
                    aria-label={`Name for ${identity}${
                      caption ? ` — ${caption}` : ""
                    }`}
                    defaultValue={connection.label ?? ""}
                    placeholder="Add a name"
                    maxLength={64}
                    disabled={busy}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") setRenaming(undefined);
                    }}
                    onBlur={(event) => {
                      if (!renameHeldFocus.current) return;
                      setRenaming(undefined);
                      if (event.target.value !== (connection.label ?? ""))
                        void update(connection, "label", event.target.value);
                    }}
                  />
                ) : (
                  <>
                    <p className="truncate text-sm text-foreground">
                      {identity}
                    </p>
                    {connection.needsReauth ? (
                      <p className="truncate text-xs text-destructive">
                        Needs reconnect
                      </p>
                    ) : (
                      caption && (
                        <p className="truncate text-xs text-muted-foreground">
                          {caption}
                        </p>
                      )
                    )}
                  </>
                )}
              </div>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={busy}
                    // Two accounts can share an address, so the caption has
                    // to disambiguate or both buttons read the same.
                    aria-label={`Manage ${identity}${
                      caption ? ` — ${caption}` : ""
                    }`}
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() => setRenaming(connection.connectionId)}
                  >
                    Rename
                  </DropdownMenuItem>
                  {!connection.isDefault && (
                    <DropdownMenuItem
                      disabled={connection.needsReauth}
                      onSelect={() => void update(connection, "default")}
                    >
                      Set as default
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onSelect={() =>
                      void onAuthenticate({
                        kind: "replace",
                        credentialId: connection.connectionId,
                      })
                    }
                  >
                    Reconnect
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={() => setRemoving(connection)}
                  >
                    Remove
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
      </div>

      {!shared && canAddAccount && (
        <button
          type="button"
          disabled={busy || connections.length >= 8}
          onClick={() => void onAuthenticate({ kind: "add" })}
          className="flex w-full items-center gap-3 rounded-lg px-1 py-1.5 text-left hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
        >
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground"
          >
            <Plus className="size-4" />
          </span>
          <span className="text-sm text-foreground">
            Connect another account
          </span>
        </button>
      )}

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
    </div>
  );
}
