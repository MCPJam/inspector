import { useRef, useState, type ReactNode } from "react";
import { MoreHorizontal, Plus, Users } from "lucide-react";
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
import { useSignInSharing } from "@/hooks/use-sign-in-sharing";
import {
  type ConnectionIntent,
  type OAuthConnection,
} from "@/shared/oauth-connections";
import { SignInSharingControl } from "./SignInSharingControl";

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
    // No profile, as with a test user's uploaded token: its name is all that
    // tells the accounts apart, and it is what suite settings call it.
    connection.label ||
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
  const { connections, shared, loaded, error } = useHostedOAuthConnections(
    projectId,
    serverId,
    enabled,
  );
  const canAddAccount = useMultiAccountConnectionsEnabled();
  const sharing = useSignInSharing({ projectId, serverId, enabled });
  if (!enabled || !projectId || !serverId) return null;
  return (
    <ConnectionAccountsList
      connections={connections}
      shared={loaded ? shared : undefined}
      error={error}
      canAddAccount={canAddAccount}
      isAdmin={sharing.isAdmin}
      sharingControl={
        loaded && sharing.canShare ? (
          <SignInSharingControl
            shared={shared}
            accountCount={shared ? connections.length : 0}
            onChange={async (next) => {
              await sharing.setSharing(next);
              // So the live connection signs in with the new kind of account.
              await onSwitch();
            }}
          />
        ) : null
      }
      onAuthenticate={onAuthenticate}
      onUpdate={async (connection, operation, label) => {
        await updateOAuthConnection(
          projectId,
          serverId,
          connection.connectionId,
          operation,
          label,
        );
        if (operation === "default" || operation === "delete") await onSwitch();
      }}
    />
  );
}

/**
 * The list itself, given its rows. On a shared server the rows are the
 * project's accounts: admins manage them and connect more, and everyone else
 * sees them read-only, since the backend refuses their writes.
 */
export function ConnectionAccountsList({
  connections,
  shared,
  error,
  canAddAccount,
  isAdmin,
  sharingControl,
  onAuthenticate,
  onUpdate,
}: {
  connections: OAuthConnection[];
  /** Undefined until the server's list answers. */
  shared: boolean | undefined;
  error?: string;
  canAddAccount: boolean;
  isAdmin: boolean;
  sharingControl?: ReactNode;
  onAuthenticate: (intent: ConnectionIntent) => void | Promise<void>;
  onUpdate: (
    connection: OAuthConnection,
    operation: "label" | "default" | "delete",
    label?: string,
  ) => Promise<void>;
}) {
  const canManage = shared !== true || isAdmin;
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string>();
  const renameRef = useRef<HTMLInputElement>(null);
  // A blur that arrives before the field ever held focus commits nothing.
  const renameHeldFocus = useRef(false);
  // Set when Rename is picked. The field takes focus only once the menu has
  // closed: while it is open, the menu's focus trap pulls focus back out of
  // the field, and on close it hands focus to its trigger — either blur would
  // close the edit the instant it opened.
  const renameOnMenuClose = useRef(false);
  const [removing, setRemoving] = useState<OAuthConnection>();

  const update = async (
    connection: OAuthConnection,
    operation: "label" | "default" | "delete",
    label?: string,
  ) => {
    setBusy(true);
    try {
      await onUpdate(connection, operation, label);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update account");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 pt-2">
      {sharingControl ? <div className="pb-2">{sharingControl}</div> : null}
      <p className="text-xs font-medium text-muted-foreground">
        {shared ? "Project accounts" : "Connected accounts"}
      </p>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      {/* Whoever has no share control still sees that the server is shared. */}
      {shared && !sharingControl ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Users aria-hidden className="mt-px size-3.5 shrink-0" />
          Shared with the project. Your hosted runs can act as these accounts,
          and project admins manage them.
        </p>
      ) : null}
      {shared && !connections.length ? (
        <p className="text-xs text-muted-foreground">
          {isAdmin
            ? "No project accounts yet. Connect one so members' hosted runs can use it."
            : "No project accounts yet. Ask a project admin to connect one."}
        </p>
      ) : null}

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
                      caption ? `: ${caption}` : ""
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

              {canManage ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={busy}
                      // Two accounts can share an address, so the caption has
                      // to disambiguate or both buttons read the same.
                      aria-label={`Manage ${identity}${
                        caption ? `: ${caption}` : ""
                      }`}
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    onCloseAutoFocus={(event) => {
                      if (!renameOnMenuClose.current) return;
                      renameOnMenuClose.current = false;
                      event.preventDefault();
                      renameRef.current?.focus();
                      renameRef.current?.select();
                    }}
                  >
                    <DropdownMenuItem
                      onSelect={() => {
                        renameHeldFocus.current = false;
                        renameOnMenuClose.current = true;
                        setRenaming(connection.connectionId);
                      }}
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
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Hidden until the list answers: adding depends on the server's mode. */}
      {shared !== undefined && canManage && canAddAccount && (
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
            {connections.length
              ? "Connect another account"
              : "Connect an account"}
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
