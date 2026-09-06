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
import {
  UNKNOWN_CONNECTION_STATUS,
  getConnectionStatusMeta,
} from "@/components/connection/server-card-utils";
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
 * Local writes the `serverAttachments` query has not reflected yet.
 *
 * `added` are rows written here and not yet listed; `removed` are rows deleted
 * here and still listed. Nothing else is needed: the query itself says when an
 * entry can go.
 */
type PendingWrites = {
  added: EvalServerAttachment[];
  removed: string[];
};

const NO_PENDING: PendingWrites = { added: [], removed: [] };

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
  const { serverAttachments, isLoading: attachmentsLoading } =
    useProjectServerAttachments({ isAuthenticated, projectId });
  const { servers: catalogRows, isLoading: catalogLoading } = useProjectServers(
    { isAuthenticated, projectId },
  );
  const appState = useOptionalSharedAppState();
  const actions = useServerActionsOptional();
  const createServerAttachment = useMutation(
    "serverAttachments:createServerAttachment" as any,
  );
  const deleteServerAttachment = useMutation(
    "serverAttachments:deleteServerAttachment" as any,
  );

  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  /**
   * The writes this picker has made that the query has not caught up with.
   *
   * ONE overlay, not two bridges. Both halves exist for the same reason — a
   * Convex query lags the mutation that changed it — and they release on the
   * same rule: an entry lives exactly as long as the query still disagrees
   * with it. Splitting that into a row-shaped "just created" and a list-shaped
   * "just deleted" meant two release effects, two ideas of when a write has
   * landed, and a third one waiting to be written for the next write kind.
   */
  const [pending, setPending] = useState<PendingWrites>(NO_PENDING);

  /**
   * A SAME-TICK backstop for `busy`, and deliberately nothing more.
   *
   * `busy` remains the one flag and the mechanism: it disables every control
   * that could start a write, so a refusal the user cannot see never has to
   * happen. But it is React state. Two events dispatched before React commits
   * that disable both read the pre-write render, and both start a mutation —
   * two rows minted for one server, or two groups from one Create.
   *
   * This closes only that window, and closes it silently on purpose: the
   * second event is not a choice to refuse and explain, it is the same choice
   * arriving twice. Anything a user could reasonably retry still goes through
   * `busy`, which they can see.
   *
   * NOT covered by a test, and that is not an oversight. React flushes a
   * discrete event synchronously, so by the second `fireEvent` the DOM already
   * carries `disabled` and jsdom fires nothing — the window is unreachable
   * from jsdom, which is also why the practical risk through a mouse is small.
   * The double-click test in the suite passes with or without this ref and
   * says so. Deleting this because "no test fails" would be reading that
   * backwards.
   */
  const writing = useRef(false);


  /**
   * One list for every reader: the query, corrected by what we know it has not
   * seen. Without the `added` half the trigger falls back to the empty label
   * right after a pick and a second pick mints a duplicate; without `removed`
   * a deleted row sits on the Groups tab, still clickable.
   *
   * Sets, not `includes`: this runs on every render until the query settles.
   */
  const attachments = useMemo(() => {
    if (pending.added.length === 0 && pending.removed.length === 0) {
      return serverAttachments;
    }
    const removed = new Set(pending.removed);
    const listed = new Set(serverAttachments.map((a) => a._id));
    return [
      ...serverAttachments.filter((row) => !removed.has(row._id)),
      ...pending.added.filter(
        (row) => !listed.has(row._id) && !removed.has(row._id),
      ),
    ];
  }, [serverAttachments, pending]);

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

  /**
   * Both hooks flatten `undefined` to an empty list, so "in flight" and
   * "answered, and empty" arrive identically. `isLoading` is the only thing
   * that separates them — and it is false for a SKIPPED query, which
   * `catalogRows === undefined` is not: `useProjectServers` skips for a local
   * or UUID project id, where reading undefined as in-flight would leave the
   * tab loading for ever.
   */
  const catalogKnown = !catalogLoading;
  const attachmentsKnown = !attachmentsLoading;

  /**
   * One flag, and the only guard the write paths have. It disables every
   * control that could start a write, so the handlers' own checks are
   * backstops rather than the mechanism — a refusal the user cannot see reads
   * as a broken control, which is what three separate silent early-returns
   * used to produce.
   */
  const busy = creating || disabled || !attachmentsKnown;

  /**
   * The one release rule: an entry goes when the query stops disagreeing with
   * it. A written row is listed; a deleted row is not.
   *
   * Only once the query has ANSWERED — it flattens `undefined` to `[]` while
   * in flight, and reading that as "the write landed" would drop both halves a
   * render before the real list arrives, blanking a fresh selection and
   * resurrecting a deleted row in the same tick.
   */
  useEffect(() => {
    if (!attachmentsKnown) return;
    if (pending.added.length === 0 && pending.removed.length === 0) return;
    const listed = new Set(serverAttachments.map((row) => row._id));
    setPending((prev) => {
      const added = prev.added.filter((row) => !listed.has(row._id));
      const removed = prev.removed.filter((id) => listed.has(id));
      // Same identity when nothing changed, so React bails out of the render
      // rather than looping on `serverAttachments`, which is a fresh array
      // every time until the query settles.
      return added.length === prev.added.length &&
        removed.length === prev.removed.length
        ? prev
        : { added, removed };
    });
  }, [serverAttachments, attachmentsKnown, pending]);

  /**
   * The one deadline, and only for a written row the query never lists.
   *
   * That is the NORMAL state for a caller which commits through its own
   * mutation before echoing the id back — the suite bar awaits `updateSuite`.
   * A row that is still what `value` points at is exempt: it is the only thing
   * that can name the trigger, so dropping it on a timer would blank a live
   * selection. Everything else just stops being held for the life of the
   * mount. It has to outlast a round trip; at 3s it fired mid-flight.
   */
  useEffect(() => {
    const orphan = pending.added.find((row) => row._id !== value);
    if (!orphan) return;
    const timer = setTimeout(() => {
      setPending((prev) => ({
        ...prev,
        added: prev.added.filter((row) => row._id !== orphan._id),
      }));
    }, 60_000);
    return () => clearTimeout(timer);
  }, [pending, value]);
  const catalog = useMemo(() => catalogRows ?? [], [catalogRows]);
  const runtime = appState?.servers ?? null;

  const selection = useMemo(
    () => resolvePickerSelection(attachments, value),
    [attachments, value],
  );

  /**
   * The selection the trigger is entitled to act on. A `dangling` row is one
   * the list does not hold — which, until the list answers, is every row. The
   * label already falls back for it; the styling and the clear control have to
   * agree, or one render says both "nothing is selected" and "something is".
   */
  const resolved =
    selection && selection.kind !== "dangling" ? selection : null;

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
        // Both halves come from the one helper the server cards and the
        // header strip also read, so a status cannot be worded one way here
        // and painted another there. Narrowed to the two fields the panel's
        // contract declares — it has no business seeing the icon.
        const meta = connectionStatus
          ? getConnectionStatusMeta(connectionStatus)
          : null;
        return {
          id: server._id,
          name: server.name,
          status: meta
            ? {
                label: meta.label,
                indicatorClassName: meta.indicatorClassName,
              }
            : UNKNOWN_CONNECTION_STATUS,
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
      // Backstops. `busy` disables every control that reaches these, so a
      // click cannot arrive in either state — but neither is safe to run:
      // a selection reported mid-write is overwritten by that write's own
      // `onChange`, and a mint against a list we have not been handed writes
      // the duplicate the backend then rejects on its name.
      if (writing.current || creating || !attachmentsKnown) return;

      // Taken before the branch, not inside the mint: reporting a selection
      // while a create is in flight is the same defect from the other side —
      // that create's own `onChange` lands second and overwrites it.
      writing.current = true;
      try {
        const existing = findSoloGroup(attachments, serverId);
        if (existing) {
          // AWAITED, like both mint paths. `onChange` is typed `=> void`, but
          // bivariance lets a caller pass an async commit, and returning here
          // before it settles releases the latch in the `finally` below while
          // the parent is still writing — reopening the very window the latch
          // was taken to close.
          try {
            await onChange(existing._id, existing as EvalServerAttachment);
            setOpen(false);
          } catch (err) {
            const raw = err instanceof Error ? err.message : "";
            toast.error(raw || `Couldn't select ${existing.name}`);
          }
          return;
        }

        const server = catalog.find((row) => row._id === serverId);
        if (!server) return;

        setCreating(true);
        // Which half failed. The collision wording belongs to the WRITE:
        // matched against the caller's commit error it told the user to
        // rename a group that had just been written, and a rename writes a
        // second one.
        let wrote = false;
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
          wrote = true;
          const created: EvalServerAttachment = {
            _id: result._id,
            name,
            serverIds: [serverId],
            resolvedServerNames: [server.name],
          };
          setPending((prev) => ({ ...prev, added: [...prev.added, created] }));
          // Awaited for the same reason as the group path.
          await onChange(result._id, created);
          setOpen(false);
        } catch (err) {
          const raw = err instanceof Error ? err.message : "";
          toast.error(
            !wrote && /already exists/i.test(raw)
              ? `A server group named after "${server.name}" already exists.`
              : raw || `Couldn't select ${server.name}`,
          );
        } finally {
          setCreating(false);
        }
      } finally {
        writing.current = false;
      }
    },
    [
      attachments,
      attachmentsKnown,
      catalog,
      createServerAttachment,
      creating,
      onChange,
      projectId,
    ],
  );

  /** Persist a multi-server group from the panel's form, then select it. */
  const handleCreateGroup = useCallback(
    async (name: string, serverIds: string[]) => {
      // A backstop, like the one on the server path: `busy` covers this state
      // so the form cannot be reached, let alone submitted. If it ever is, a
      // name derived against a list that has not arrived collides — and
      // throwing keeps the draft rather than costing the user what they picked.
      if (!attachmentsKnown) {
        toast.error("Still loading this project's server groups.");
        throw new Error("Attachments not loaded");
      }
      /**
       * THROWN, not returned: the panel reads a rejection as "keep the draft"
       * and a resolution as "it landed, clear the form". Resolving here would
       * throw away the servers the user picked while the first submit — the
       * one that owns this draft — is still in flight.
       *
       * And SAID, because the panel's catch deliberately reports nothing: its
       * comment reads "The caller reports the reason", so a bare throw leaves
       * the spinner stopping over a full form with no explanation — the dead
       * control `busy` exists to avoid.
       */
      if (writing.current) {
        toast.error("Still saving the last change — try again in a moment.");
        throw new Error("A write is already in flight");
      }
      writing.current = true;
      setCreating(true);
      // Same split as the bare-server path: the collision wording is the
      // WRITE's, not the caller's commit's.
      let wrote = false;
      try {
        const result = (await createServerAttachment({
          projectId,
          name,
          serverIds,
        })) as { _id: string };
        wrote = true;
        const byId = new Map(catalog.map((row) => [row._id, row.name]));
        const created: EvalServerAttachment = {
          _id: result._id,
          name,
          serverIds,
          // Positional, never compacted: the model documents these as parallel
          // to `serverIds`, and `isServerStandIn` reads index 0. Dropping a
          // gap shifts every later name onto the wrong id.
          resolvedServerNames: serverIds.map((id) => byId.get(id) ?? ""),
        };
        setPending((prev) => ({ ...prev, added: [...prev.added, created] }));
        // Awaited: `onChange` is typed `=> void`, but bivariance lets a caller
        // pass an async commit — the suite bar passes an awaited `updateSuite`
        // — and an un-awaited rejection escapes this catch entirely.
        await onChange(result._id, created);
        setOpen(false);
      } catch (err) {
        const raw = err instanceof Error ? err.message : "";
        toast.error(
          !wrote && /already exists/i.test(raw)
            ? `A server group named "${name}" already exists.`
            : raw || "Failed to create server group",
        );
        throw err;
      } finally {
        setCreating(false);
        writing.current = false;
      }
    },
    [attachmentsKnown, catalog, createServerAttachment, onChange, projectId],
  );

  /**
   * Bound to the names already taken in this project — the panel supplies the
   * picked servers, this supplies the rule.
   *
   * For ONE server the shared deriver returns that server's own name, which is
   * exactly what `isServerStandIn` reads as "not a group": suggesting it here
   * would hide the group off the Groups tab the moment it was created. The
   * bare-server mint still wants that name, and calls the deriver directly.
   */
  const deriveName = useCallback(
    (pickedServerNames: string[]) => {
      const taken = attachments.map((a) => a.name ?? "");
      if (pickedServerNames.length !== 1) {
        return deriveServerGroupName(pickedServerNames, taken);
      }
      /**
       * The numbered name, not the server's own — that one IS the stand-in
       * shape, so suggesting it would hide the group being made.
       *
       * Known gap, and not closable by naming: for a server called literally
       * `group`, every `Group N` reads as ITS stand-in, because the rule
       * infers kind from the name and the numbering stem is that name. Closing
       * it wants the storage column, the same one the rename case wants.
       */
      return deriveServerGroupName([], taken);
    },
    [attachments],
  );

  /**
   * Remove a group. The picker this replaced owned the only call to this
   * mutation in the app; without it a project accumulates rows — including
   * the stand-ins every bare-server pick mints — that nothing can clear.
   *
   * The backend refuses a group a suite still uses and says which; that
   * message is worth more than anything phrased here, so it is passed through.
   */
  const handleDeleteGroup = useCallback(
    async (groupId: string) => {
      if (writing.current || creating) return;
      // Removing what the parent is storing, with no way to tell it, would
      // leave that id pointing at nothing — the picker would read as empty
      // while the surface kept launching against a row that is gone.
      if (value === groupId && !onClearSelection) {
        toast.error("Pick a different server first — this one is in use here.");
        return;
      }
      writing.current = true;
      setCreating(true);
      try {
        await deleteServerAttachment({ serverAttachmentId: groupId });
        // Both halves, in one move: drop it from `added` (a row minted and
        // deleted in one sitting was never in the query to begin with) and
        // record it in `removed` (a row the query still returns would
        // otherwise sit on the tab, and stay clickable, until the refetch).
        setPending((prev) => ({
          added: prev.added.filter((row) => row._id !== groupId),
          removed: prev.removed.includes(groupId)
            ? prev.removed
            : [...prev.removed, groupId],
        }));
        if (value === groupId) onClearSelection?.();
      } catch (err) {
        const raw = err instanceof Error ? err.message : "";
        toast.error(raw || "Couldn't delete that server group.");
      } finally {
        setCreating(false);
        writing.current = false;
      }
    },
    [creating, deleteServerAttachment, onClearSelection, value],
  );

  /**
   * Reporting an existing row IS the same operation the bare-server reuse path
   * performs, so it holds the latch the same way. Reading the flag without
   * taking it left two group picks — or a group pick followed by a server pick
   * — free to interleave their `onChange` calls, and the later one wins.
   */
  const handleSelectGroup = useCallback(
    async (groupId: string) => {
      if (writing.current || creating) return;
      const group = attachments.find((row) => row._id === groupId);
      if (!group) return;
      writing.current = true;
      try {
        await onChange(group._id, group as EvalServerAttachment);
        setOpen(false);
      } catch (err) {
        const raw = err instanceof Error ? err.message : "";
        toast.error(raw || `Couldn't select ${group.name}`);
      } finally {
        writing.current = false;
      }
    },
    [attachments, creating, onChange],
  );

  // A dangling selection (its row was deleted) still reads as the empty label
  // here. The model distinguishes it; surfacing that is deliberately left to
  // its own change rather than folded into this one.
  /**
   * While the list is unknown EVERY selection resolves as dangling, so falling
   * back to the empty label would assert "nothing picked" over a live one —
   * the same claim BB-182 was about, one query over.
   */
  const triggerLabel = resolved
    ? resolved.label
    : !attachmentsKnown && value
      ? "Loading…"
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
            resolved
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

      {/*
        `selection`, not `resolved`: a dangling id is exactly the one that most
        needs a way out, and the label already falls back for it. Withheld
        while the list is unknown (every row looks dangling then) and while a
        write is in flight (its `onChange` would undo the clear).
      */}
      {onClearSelection &&
      selection &&
      attachmentsKnown &&
      !busy ? (
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
          onSelectGroup={(groupId) => void handleSelectGroup(groupId)}
          onCreateGroup={handleCreateGroup}
          deriveName={deriveName}
          catalogKnown={catalogKnown}
          busy={busy}
          onDeleteGroup={
            disabled ? undefined : (id) => void handleDeleteGroup(id)
          }
        />
      </PopoverContent>
    </Popover>
  );
}
