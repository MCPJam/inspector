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
import { useSignInSharing } from "@/hooks/use-sign-in-sharing";
import {
  connectionLabel,
  type ConnectionIntent,
  type OAuthConnection,
} from "@/shared/oauth-connections";
import { SignInSharingControl } from "./SignInSharingControl";
import { LocalRunsControl } from "./LocalRunsControl";
import {
  EXPIRY_UNKNOWN,
  formatAccountTime,
} from "@/lib/evals/run-account-credentials";

/**
 * Who the server says the account is, for the line under its name: under a
 * rename, the email or name the server shared, so a renamed account still
 * shows which login it is; under an email, the profile name, which tells two
 * accounts on one address apart. Nothing that would repeat the name.
 */
function serverIdentityOf(
  connection: OAuthConnection,
  name: string,
): string | undefined {
  const profile = connection.profile;
  const detail = connection.label
    ? profile?.email || profile?.name || profile?.nickname
    : name === profile?.email
      ? profile?.name || profile?.nickname
      : undefined;
  return detail && detail !== name ? detail : undefined;
}

/**
 * When a shared or uploaded account's token stops working. Nobody signs in
 * to renew one, so its expiry is worth showing, and an opaque token uploaded
 * without `expires_in` has none to show.
 */
function expiryOf(connection: OAuthConnection): string | undefined {
  if (!connection.hostedOnly) return undefined;
  const { expiresAt } = connection;
  if (expiresAt === undefined) return EXPIRY_UNKNOWN;
  return `${expiresAt <= Date.now() ? "Expired" : "Expires"} ${formatAccountTime(expiresAt)}`;
}

/** Who the account is on the server, whether it is the default, and its expiry. */
function captionOf(
  connection: OAuthConnection,
  name: string,
): string | undefined {
  if (connection.needsReauth) return undefined;
  return (
    [
      serverIdentityOf(connection, name),
      connection.isDefault ? "Default" : null,
      expiryOf(connection),
    ]
      .filter(Boolean)
      .join(" · ") || undefined
  );
}

/** The words that differ between an MCP server's accounts and other kinds. */
export interface AccountListTerms {
  /** The row's note when the account can't be used until someone acts. */
  needsReauth: string;
  /** The row menu's way to fix it. Without one, the menu offers none. */
  reauthenticate?: string;
  /** What removing an account deletes. */
  removeBody: string;
}

export const SERVER_ACCOUNT_TERMS: AccountListTerms = {
  needsReauth: "Needs reconnect",
  reauthenticate: "Reconnect",
  removeBody: "MCPJam will remove this connection and its stored credentials.",
};

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
  const {
    connections,
    shared,
    localDeliveryAllowed,
    loaded,
    landed,
    error,
    refetch,
  } = useHostedOAuthConnections(projectId, serverId, enabled);
  const sharing = useSignInSharing({ projectId, serverId, enabled });
  if (!enabled || !projectId || !serverId) return null;
  return (
    <ConnectionAccountsList
      connections={connections}
      shared={loaded ? shared : undefined}
      error={error}
      onReload={refetch}
      isAdmin={sharing.isAdmin}
      localDeliveryAllowed={localDeliveryAllowed}
      sharingControl={
        // Allow local runs doesn't wait for the eval flag: local runs are for
        // every organization, and local apps often read flags as off.
        loaded && (sharing.canShare || (sharing.isAdmin && shared)) ? (
          <div className="space-y-2">
            {sharing.canShare ? (
              <SignInSharingControl
                shared={shared}
                accountCount={shared ? connections.length : 0}
                onChange={async (next) => {
                  await sharing.setSharing(next);
                  // So the live connection signs in with the new kind of account.
                  // The sharing change is saved either way, so a failed reconnect
                  // gets its own message instead of failing the change.
                  try {
                    await onSwitch();
                  } catch {
                    toast.error(
                      "Sharing changed, but the server could not reconnect. Reconnect it to use the new accounts.",
                    );
                  }
                }}
              />
            ) : null}
            {shared && sharing.isAdmin ? (
              <LocalRunsControl
                allowed={localDeliveryAllowed}
                listVersion={landed}
                onChange={sharing.setLocalRuns}
              />
            ) : null}
          </div>
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
// The backend's caps (`lib/connectionProfile.ts`): 8 live accounts per
// server, and 16 rows counting the ones that need reconnecting.
const MAX_LIVE_ACCOUNTS = 8;
const MAX_ACCOUNT_ROWS = 16;

export function ConnectionAccountsList({
  connections,
  shared,
  error,
  onReload,
  isAdmin,
  sharingControl,
  localDeliveryAllowed,
  onAuthenticate,
  onUpdate,
  terms = SERVER_ACCOUNT_TERMS,
}: {
  connections: OAuthConnection[];
  /** Undefined until the server's list answers. */
  shared: boolean | undefined;
  /** On a shared server: whether members' local apps may use its accounts. */
  localDeliveryAllowed?: boolean;
  error?: string;
  /** Loads the list again after it failed to load. */
  onReload?: () => void;
  isAdmin: boolean;
  sharingControl?: ReactNode;
  /** Adds an account or signs one in again. Without it the list offers neither. */
  onAuthenticate?: (intent: ConnectionIntent) => void | Promise<void>;
  onUpdate: (
    connection: OAuthConnection,
    operation: "label" | "default" | "delete",
    label?: string,
  ) => Promise<void>;
  terms?: AccountListTerms;
}) {
  const canManage = shared !== true || isAdmin;
  // An account that needs reconnecting holds no token, so it doesn't count.
  const atAccountLimit =
    connections.filter((connection) => !connection.needsReauth).length >=
      MAX_LIVE_ACCOUNTS || connections.length >= MAX_ACCOUNT_ROWS;
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
        <div className="flex items-center gap-2">
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
          {onReload ? (
            <Button variant="ghost" size="sm" onClick={onReload}>
              Reload accounts
            </Button>
          ) : null}
        </div>
      )}

      {/* Whoever has no share control still sees that the server is shared. */}
      {shared && !sharingControl ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Users aria-hidden className="mt-px size-3.5 shrink-0" />
          {localDeliveryAllowed
            ? "Shared with the project. Your runs, including your local app's, can act as these accounts, and project admins manage them."
            : "Shared with the project. Your hosted runs can act as these accounts, and project admins manage them. To use them from your local app, ask a project admin to turn on Allow local runs."}
        </p>
      ) : null}
      {shared && !connections.length ? (
        <p className="text-xs text-muted-foreground">
          {isAdmin
            ? "No project accounts yet. Connect one so members' runs can use it."
            : "No project accounts yet. Ask a project admin to connect one."}
        </p>
      ) : null}

      <div className="space-y-1">
        {connections.map((connection, index) => {
          // The user's name for the account, else the server's, else its
          // stored number: one name per account, the same as chat's.
          const identity = connectionLabel(connection, index);
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
                        {terms.needsReauth}
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
                    {terms.reauthenticate && onAuthenticate ? (
                      <DropdownMenuItem
                        onSelect={() =>
                          void onAuthenticate({
                            kind: "replace",
                            credentialId: connection.connectionId,
                          })
                        }
                      >
                        {terms.reauthenticate}
                      </DropdownMenuItem>
                    ) : null}
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
      {shared !== undefined && canManage && onAuthenticate && (
        <button
          type="button"
          disabled={busy || atAccountLimit}
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
            <AlertDialogDescription>{terms.removeBody}</AlertDialogDescription>
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
