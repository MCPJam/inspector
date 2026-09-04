/**
 * The data-bound server picker: trigger + popover + `ServerPickerPanel`.
 *
 * Joins two worlds the panel is kept innocent of — the Convex catalog (by id)
 * and the runtime connection state (by name). Both providers are read through
 * their OPTIONAL hooks: several surfaces mount this outside them, and
 * `useServerActions` throws.
 *
 * Storage has no column for a bare server, so picking one resolves to the row
 * holding exactly it — reused when it exists, minted otherwise.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Server, X } from "lucide-react";
import { useConvexAuth, useMutation } from "convex/react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";

import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { navigateApp, routePaths } from "@/lib/app-navigation";
import { useProjectServerAttachments, useProjectServers } from "@/hooks/useViews";
import { useOptionalSharedAppState } from "@/state/app-state-context";
import { useServerActionsOptional } from "@/state/server-actions-context";
import { getConnectionStatusMeta } from "@/components/connection/server-card-utils";
import type { ConnectionStatus } from "@/state/app-types";
import type { EvalServerAttachment } from "@/components/evals/types";

import { deriveServerGroupName } from "./server-group-name";
import {
  findSoloGroup,
  initialPickerTab,
  listGroupsForTab,
  resolvePickerSelection,
  resolveServerConnection,
  type PickerTab,
} from "./server-picker-model";
import {
  ServerPickerPanel,
  type ServerPickerServerRow,
} from "@mcpjam/design-system/server-picker-panel";

/**
 * A dot for a server whose connection state we cannot read. It holds the row's
 * alignment without asserting anything — the opposite of painting it grey,
 * which would read as "disconnected".
 */
const UNKNOWN_STATUS = {
  label: "Connection state unavailable",
  indicatorClassName: "bg-transparent",
};

/**
 * The dot's colour, as a role token rather than the hex `getConnectionStatusMeta`
 * carries — the panel renders in both themes and a fixed colour follows neither.
 * The helper still supplies the label, so the two stay in step.
 */
const STATUS_INDICATOR: Record<ConnectionStatus, string> = {
  connected: "bg-success",
  connecting: "bg-info",
  "oauth-flow": "bg-pending",
  failed: "bg-destructive",
  disconnected: "bg-muted-foreground",
};

export type ServerPickerProps = {
  projectId: string;
  /** The selected `serverAttachments` row id. */
  value: string | null;
  onChange: (
    serverAttachmentId: string,
    attachment: EvalServerAttachment,
  ) => void;
  disabled?: boolean;
  /** Trigger label when nothing is selected. */
  emptyTriggerLabel?: string;
  /**
   * Return to no selection. Only surfaces where the server is optional pass
   * this, and only they get the control — the picker itself cannot tell an
   * optional field from a required one.
   */
  onClearSelection?: () => void;
  /**
   * Render the popover in place instead of portaling it. Set inside a modal
   * Dialog, whose overlay swallows clicks on portaled content. Same escape
   * hatch, same name, as `EnvironmentPicker`.
   */
  inModal?: boolean;
  triggerTestId?: string;
};

export function ServerPicker({
  projectId,
  value,
  onChange,
  disabled = false,
  emptyTriggerLabel = "Select server",
  onClearSelection,
  inModal = false,
  triggerTestId,
}: ServerPickerProps) {
  const { isAuthenticated } = useConvexAuth();
  const { serverAttachments } = useProjectServerAttachments({
    isAuthenticated,
    projectId,
  });
  const { servers: catalogRows } = useProjectServers({
    isAuthenticated,
    projectId,
  });
  const appState = useOptionalSharedAppState();
  const actions = useServerActionsOptional();
  const createServerAttachment = useMutation(
    "serverAttachments:createServerAttachment" as any,
  );

  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<EvalServerAttachment | null>(
    null,
  );

  // The latch the write paths read. `creating` renders the UI but is only
  // readable a commit later, and both writes start within one tick of a click.
  const writing = useRef(false);

  /**
   * One list for every reader: the live query plus a row we just minted that it
   * has not caught up with. Without it the trigger falls back to the empty
   * label right after a pick, and a second pick of the same server mints a
   * duplicate that the backend then rejects on its name.
   */
  const attachments = useMemo(() => {
    if (!justCreated) return serverAttachments;
    if (serverAttachments.some((a) => a._id === justCreated._id)) {
      return serverAttachments;
    }
    return [...serverAttachments, justCreated];
  }, [serverAttachments, justCreated]);

  useEffect(() => {
    if (!justCreated) return;
    // Released as soon as the query reflects the row.
    if (serverAttachments.some((a) => a._id === justCreated._id)) {
      setJustCreated(null);
      return;
    }
    // While it is still what `value` points at, it is the only thing that can
    // name the trigger — dropping it on a timer would blank a live selection.
    if (value === justCreated._id) return;
    // The parent moved on without the query ever catching up: stop holding a
    // row nothing refers to.
    const timer = setTimeout(() => setJustCreated(null), 3000);
    return () => clearTimeout(timer);
  }, [justCreated, serverAttachments, value]);

  /**
   * `ensureServersReady` runs with `allowInteractiveOAuthFlow: false`, so a
   * server needing consent returns in `reauthServerNames` rather than popping
   * a window. Success needs no toast — the dot turns green on its own.
   */
  const handleConnect = useCallback(
    async (serverName: string) => {
      if (!actions) return;
      const goToServers = {
        action: {
          label: "Open servers",
          onClick: () => navigateApp(routePaths.servers),
        },
      };
      try {
        const result = await actions.ensureServersReady([serverName]);
        if (result.readyServerNames.includes(serverName)) return;
        if (result.reauthServerNames.includes(serverName)) {
          toast.error(`${serverName} needs authorizing before it can connect.`, goToServers);
          return;
        }
        toast.error(`${serverName} didn't connect.`, goToServers);
      } catch (err) {
        const raw = err instanceof Error ? err.message : "";
        toast.error(
          raw ? `${serverName} didn't connect: ${raw}` : `${serverName} didn't connect.`,
          goToServers,
        );
      }
    },
    [actions],
  );

  // `undefined` until the query answers. Kept apart from an answered-and-empty
  // catalog so the panel never claims a project has no servers on a guess.
  const catalogKnown = catalogRows !== undefined;
  const catalog = useMemo(() => catalogRows ?? [], [catalogRows]);
  const runtime = appState?.servers ?? null;

  const selection = useMemo(
    () => resolvePickerSelection(attachments, value),
    [attachments, value],
  );

  // Seeded from the selection, then owned by the user for as long as the
  // popover stays open — re-deriving on every render would yank them back to
  // the Groups tab the moment they picked a group and kept browsing.
  const [tab, setTab] = useState<PickerTab>(() => initialPickerTab(selection));

  const serverRows = useMemo<ServerPickerServerRow[]>(
    () =>
      catalog.map((server) => {
        const { status, canConnect } = resolveServerConnection(
          server.name,
          runtime,
        );
        const connectionStatus =
          status === null ? null : (status as ConnectionStatus);
        return {
          id: server._id,
          name: server.name,
          status: connectionStatus
            ? {
                label: getConnectionStatusMeta(connectionStatus).label,
                indicatorClassName: STATUS_INDICATOR[connectionStatus],
              }
            : UNKNOWN_STATUS,
          onConnect:
            canConnect && actions
              ? () => void handleConnect(server.name)
              : undefined,
        };
      }),
    [catalog, runtime, actions, handleConnect],
  );

  const groupRows = useMemo(
    () =>
      listGroupsForTab(attachments).map((group) => ({
        id: group._id,
        name: group.name,
        serverNames: group.resolvedServerNames ?? [],
      })),
    [attachments],
  );

  const handleSelectServer = useCallback(
    async (serverId: string) => {
      const existing = findSoloGroup(attachments, serverId);
      if (existing) {
        onChange(existing._id, existing as EvalServerAttachment);
        setOpen(false);
        return;
      }

      const server = catalog.find((row) => row._id === serverId);
      if (!server) return;
      if (writing.current) return;

      writing.current = true;
      setCreating(true);
      try {
        const name = deriveServerGroupName(
          [server.name],
          attachments.map((a) => a.name ?? ""),
        );
        const result = (await createServerAttachment({
          projectId,
          name,
          serverIds: [serverId],
        })) as { _id: string };
        const created: EvalServerAttachment = {
          _id: result._id,
          name,
          serverIds: [serverId],
          resolvedServerNames: [server.name],
        };
        setJustCreated(created);
        onChange(result._id, created);
        setOpen(false);
      } catch (err) {
        const raw = err instanceof Error ? err.message : "";
        toast.error(
          /already exists/i.test(raw)
            ? `A server group named after "${server.name}" already exists.`
            : `Couldn't select ${server.name}`,
        );
      } finally {
        writing.current = false;
        setCreating(false);
      }
    },
    [attachments, catalog, createServerAttachment, onChange, projectId],
  );

  /** Persist a multi-server group from the panel's form, then select it. */
  const handleCreateGroup = useCallback(
    async (name: string, serverIds: string[]) => {
      // Held for the same reason the server path holds it: the Servers tab
      // stays clickable while the form is submitting.
      writing.current = true;
      setCreating(true);
      try {
        const result = (await createServerAttachment({
          projectId,
          name,
          serverIds,
        })) as { _id: string };
        const byId = new Map(catalog.map((row) => [row._id, row.name]));
        const created: EvalServerAttachment = {
          _id: result._id,
          name,
          serverIds,
          resolvedServerNames: serverIds
            .map((id) => byId.get(id))
            .filter((n): n is string => Boolean(n)),
        };
        setJustCreated(created);
        onChange(result._id, created);
        setOpen(false);
      } catch (err) {
        const raw = err instanceof Error ? err.message : "";
        toast.error(
          /already exists/i.test(raw)
            ? `A server group named "${name}" already exists.`
            : "Failed to create server group",
        );
        throw err;
      } finally {
        writing.current = false;
        setCreating(false);
      }
    },
    [catalog, createServerAttachment, onChange, projectId],
  );

  // Bound to the names already taken in this project — the panel supplies the
  // picked servers, this supplies the rule.
  const deriveName = useCallback(
    (pickedServerNames: string[]) =>
      deriveServerGroupName(
        pickedServerNames,
        attachments.map((a) => a.name ?? ""),
      ),
    [attachments],
  );

  const handleSelectGroup = useCallback(
    (groupId: string) => {
      const group = attachments.find((row) => row._id === groupId);
      if (!group) return;
      onChange(group._id, group as EvalServerAttachment);
      setOpen(false);
    },
    [attachments, onChange],
  );

  // A dangling selection (its row was deleted) still reads as the empty label
  // here. The model distinguishes it; surfacing that is deliberately left to
  // its own change rather than folded into this one.
  const triggerLabel =
    selection && selection.kind !== "dangling"
      ? selection.label
      : emptyTriggerLabel;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Reopening lands on the tab that holds the current selection.
        if (next) setTab(initialPickerTab(selection));
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          data-testid={triggerTestId ?? "server-picker-trigger"}
          className={cn(
            "flex h-8 max-w-[260px] shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-foreground",
            "outline-none transition-colors",
            selection
              ? "border-border/60 bg-muted/40 hover:bg-muted/60"
              : "border-dashed border-border/60 bg-muted/30 hover:bg-muted/45",
            disabled && "cursor-not-allowed opacity-50",
          )}
        >
          <Server className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {triggerLabel}
          </span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>

      {onClearSelection && selection && !disabled ? (
        <button
          type="button"
          data-testid="server-picker-clear"
          aria-label="Clear server selection"
          onClick={onClearSelection}
          className="ml-1 flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      ) : null}

      <PopoverContent
        className="w-72 p-1.5"
        align="start"
        sideOffset={4}
        portalled={!inModal}
        onInteractOutside={(event) => {
          // A click away mid-create would drop the popover while the mutation
          // is still going. Escape stays free.
          if (creating) event.preventDefault();
        }}
      >
        <ServerPickerPanel
          tab={tab}
          onTabChange={setTab}
          servers={serverRows}
          groups={groupRows}
          selectedServerId={
            selection?.kind === "server" ? selection.serverId : null
          }
          selectedGroupId={
            selection?.kind === "group" ? selection.groupId : null
          }
          onSelectServer={(serverId) => void handleSelectServer(serverId)}
          onSelectGroup={handleSelectGroup}
          onCreateGroup={handleCreateGroup}
          deriveName={deriveName}
          catalogKnown={catalogKnown}
        />
      </PopoverContent>
    </Popover>
  );
}
