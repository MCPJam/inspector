/**
 * The data-bound picker: trigger + popover + `ServerPickerPanel`.
 *
 * Joins the Convex catalog (by id) to the runtime connection state (by name).
 * Both read through their OPTIONAL hooks — several surfaces mount this outside
 * those providers, and `useServerActions` throws.
 *
 * Storage has no column for a bare server, so picking one resolves to the row
 * holding exactly it — reused when it exists, minted otherwise.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import {
  useProjectServerAttachments,
  useProjectServers,
} from "@/hooks/useViews";
import { useOptionalSharedAppState } from "@/state/app-state-context";
import { useServerActionsOptional } from "@/state/server-actions-context";
import {
  UNKNOWN_CONNECTION_STATUS,
  getConnectionStatusMeta,
  isConnectionStatus,
} from "@/components/connection/server-card-utils";
import type { EvalServerAttachment } from "@/components/evals/types";

import { deriveServerGroupName } from "./server-group-name";
import {
  findSoloGroup,
  initialPickerTab,
  listGroupsForTab,
  resolvePickerSelection,
  resolveServerConnection,
  type PickerGroup,
  type PickerTab,
} from "./server-picker-model";
import {
  ServerPickerPanel,
  type ServerPickerServerRow,
} from "@mcpjam/design-system/server-picker-panel";

/** Local writes the `serverAttachments` query has not reflected yet. */
type PendingWrites = {
  /**
   * Carried WITH the writes so another project's render discards them by
   * DERIVATION: an effect clears one render too late, and that render is the
   * one offering the old project's rows.
   */
  projectId: string;
  added: EvalServerAttachment[];
  removed: string[];
};

const NO_PENDING: PendingWrites = { projectId: "", added: [], removed: [] };

/** How `mintAndSelect` reports a failed write, or one the project left behind. */
type MintFailure = { wrote: boolean; stale?: true };

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
  /** Passed only where the server is optional — the picker cannot tell. */
  onClearSelection?: () => void;
  /** Render in place: a modal Dialog's overlay swallows clicks on a portal. */
  inModal?: boolean;
  triggerTestId?: string;
  /** So a sibling `<Label htmlFor>` names it "Server", not "Stripe". */
  triggerId?: string;
  /**
   * Shape only. `field` lines up with an `<Input>` in a labelled column; a
   * pill beside a select reads as a different kind of control. The empty
   * label does NOT vary — one vocabulary is what BB-142 was for.
   */
  variant?: "pill" | "field";
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
  triggerId,
  variant = "pill",
}: ServerPickerProps) {
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  /**
   * Trimmed once, used everywhere downstream. The hooks query on the
   * trimmed id, so an overlay keyed on the raw prop is discarded by a caller
   * that only changed the padding — hiding the selected row and letting a
   * duplicate be minted against a project the query never left.
   */
  const project = projectId.trim();
  const {
    serverAttachments,
    isLoading: attachmentsLoading,
    isBootstrapping: attachmentsBootstrapping,
  } = useProjectServerAttachments({
    isAuthenticated,
    authLoading,
    projectId: project,
  });
  const {
    servers: catalogRows,
    isLoading: catalogLoading,
    isBootstrapping: catalogBootstrapping,
  } = useProjectServers({ isAuthenticated, authLoading, projectId: project });
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
   * Handshakes started here and not yet settled. The runtime status does not
   * flip to `connecting` until the provider says so, and until then every
   * click starts another one. A list, because two at once is reasonable.
   */
  const [connecting, setConnecting] = useState<readonly string[]>([]);

  /**
   * ONE overlay, not a bridge per write kind: both halves exist because a
   * Convex query lags its mutation, and both release on the same rule — an
   * entry lives as long as the query still disagrees with it.
   */
  const [storedPending, setPending] = useState<PendingWrites>(NO_PENDING);

  /** The overlay, but only when it belongs to the project being rendered. */
  const pending =
    storedPending.projectId === project ? storedPending : NO_PENDING;

  /**
   * A GENERATION, not the project id: leaving A for B and back makes a stale
   * completion's id match again. This only goes up.
   */
  const generation = useRef(0);
  // Bumped from a COMMITTED effect, never during render: React discards
  // interrupted renders, and a bump from one strands the write the committed
  // tree started. LAYOUT, because a passive effect runs after paint and a
  // mutation resolving in that gap still reads the old generation as current.
  useLayoutEffect(() => {
    generation.current += 1;
    // Handshakes are keyed by NAME, so carrying them over would withhold
    // Connect from a same-named server in the next project.
    setConnecting([]);
    // A hung write from the last project froze every row here until it
    // settled. Released now; every `finally` below is fenced against it.
    setCreating(false);
    writing.current = false;
  }, [project]);
  // Unmount is a project change too. Its own effect: a cleanup on the one
  // above would also fire on every project change, where the body already
  // bumped.
  useLayoutEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const sinceNow = () => {
    const started = generation.current;
    return () => generation.current === started;
  };

  /**
   * A same-tick backstop for `busy`, which is React state: two events
   * dispatched before its disable commits both read the pre-write render.
   * Covered by `server-picker-reentrancy.test.tsx` — no DOM test can reach it.
   */
  const writing = useRef(false);

  /**
   * The query, corrected by what we know it has not seen yet. Without `added`
   * a fresh pick reads as empty and the next one mints a duplicate; without
   * `removed` a deleted row stays on the Groups tab, still clickable.
   */
  const attachments = useMemo(() => {
    // Legacy rows lack `resolvedServerNames`, and the model reads a row it
    // cannot judge as a group — so every pick of that server minted another.
    const nameById = new Map(
      (catalogRows ?? []).map((row) => [row._id, row.name]),
    );
    const named = (row: EvalServerAttachment): EvalServerAttachment =>
      row.resolvedServerNames?.length === row.serverIds.length
        ? row
        : {
            ...row,
            resolvedServerNames: row.serverIds.map(
              (id, i) => row.resolvedServerNames?.[i] ?? nameById.get(id) ?? "",
            ),
          };
    if (pending.added.length === 0 && pending.removed.length === 0) {
      return serverAttachments.map(named);
    }
    const removed = new Set(pending.removed);
    const listed = new Set(serverAttachments.map((a) => a._id));
    return [
      ...serverAttachments.filter((row) => !removed.has(row._id)),
      ...pending.added.filter(
        (row) => !listed.has(row._id) && !removed.has(row._id),
      ),
    ].map(named);
  }, [serverAttachments, pending, catalogRows]);

  /**
   * `allowInteractiveOAuthFlow: false`, so a server needing consent comes back
   * in `reauthServerNames` instead of popping a window. Success says nothing —
   * the dot turns green on its own.
   */
  const handleConnect = useCallback(
    async (serverName: string) => {
      if (!actions) return;
      // Fenced: this handshake still settles after a project switch, and its
      // cleanup would drop the NEW project's entry for a same-named server.
      const isCurrent = sinceNow();
      setConnecting((names) =>
        names.includes(serverName) ? names : [...names, serverName],
      );
      const goToServers = {
        action: {
          label: "Open servers",
          onClick: () => navigateApp(routePaths.servers),
        },
      };
      try {
        const result = await actions.ensureServersReady([serverName]);
        if (!isCurrent()) return;
        if (result.readyServerNames.includes(serverName)) return;
        if (result.reauthServerNames.includes(serverName)) {
          toast.error(
            `${serverName} needs authorizing before it can connect.`,
            goToServers,
          );
          return;
        }
        toast.error(`${serverName} didn't connect.`, goToServers);
      } catch (err) {
        if (!isCurrent()) return;
        const raw = err instanceof Error ? err.message : "";
        toast.error(
          raw
            ? `${serverName} didn't connect: ${raw}`
            : `${serverName} didn't connect.`,
          goToServers,
        );
      } finally {
        if (isCurrent()) {
          setConnecting((names) => names.filter((name) => name !== serverName));
        }
      }
    },
    [actions],
  );

  /**
   * "In flight" and "answered, and empty" arrive identically — both hooks
   * flatten `undefined` to an empty list. `isLoading` separates them, except
   * for a SKIPPED query, which reports `isLoading: false` and an empty list:
   * during the DB-user bootstrap that read as "no servers" and marked a live
   * selection dangling (BB-182). `isBootstrapping` is answered by the hooks
   * that own the skip, not re-derived here.
   */
  const catalogKnown = !catalogBootstrapping && !catalogLoading;
  const attachmentsKnown = !attachmentsBootstrapping && !attachmentsLoading;

  /**
   * One flag, and the only guard the write paths have. It disables every
   * control that could start a write, so the handlers' own checks are
   * backstops rather than the mechanism — a refusal the user cannot see reads
   * as a broken control, which is what three separate silent early-returns
   * used to produce.
   */
  const busy = creating || disabled || !attachmentsKnown || !catalogKnown;

  /**
   * The one release rule: an entry goes when the query stops disagreeing with
   * it. A written row is listed; a deleted row is not.
   *
   * Only once the query has ANSWERED: `[]` while in flight would read as "the
   * write landed", blanking a fresh selection a render before the list lands.
   */
  useEffect(() => {
    if (!attachmentsKnown) return;
    if (pending.added.length === 0 && pending.removed.length === 0) return;
    const listed = new Set(serverAttachments.map((row) => row._id));
    setPending((prev) => {
      const added = prev.added.filter((row) => !listed.has(row._id));
      const removed = prev.removed.filter((id) => listed.has(id));
      // Same identity when nothing changed: `serverAttachments` is a fresh
      // array every render until the query settles, so this would loop.
      if (prev.projectId !== project) return prev;
      return added.length === prev.added.length &&
        removed.length === prev.removed.length
        ? prev
        : { ...prev, added, removed };
    });
  }, [serverAttachments, attachmentsKnown, pending, project]);

  /**
   * The one deadline, for a written row the query never lists — the normal
   * state for a caller that commits through its own mutation first. The row
   * `value` points at is exempt: dropping it would blank a live selection.
   * 60s because it must outlast a round trip; at 3s it fired mid-flight.
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
        // `isConnectionStatus`, not a cast: runtime hands us a plain string,
        // and one outside the union is a state we cannot READ. The cast made
        // it "Disconnected" with a Connect button — the same claim the strip
        // and the cards already refuse to make.
        const connectionStatus =
          status !== null && isConnectionStatus(status) ? status : null;
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
            canConnect &&
            connectionStatus !== null &&
            actions &&
            !connecting.includes(server.name)
              ? () => void handleConnect(server.name)
              : undefined,
        };
      }),
    [catalog, runtime, actions, handleConnect, connecting],
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

  /**
   * Write a row, record it locally, report it as the selection.
   *
   * Throws after reporting: `wrote` tells the caller whether the row landed,
   * which decides whether a retry would duplicate it. `stale: true` means the
   * project changed mid-flight — nothing to report, but it must not resolve
   * either, or the panel clears a draft that now belongs elsewhere.
   */
  /**
   * Awaited because `onChange` is typed `=> void` but bivariance lets a caller
   * pass an async commit — returning early releases the latch mid-write.
   * `creating` rises for the wait so the controls show it.
   */
  const selectExisting = useCallback(
    async (row: PickerGroup) => {
      setCreating(true);
      const isCurrent = sinceNow();
      try {
        await onChange(row._id, row as EvalServerAttachment);
        if (isCurrent()) setOpen(false);
      } catch (err) {
        // The user left; this error belongs to a screen they are not on.
        if (!isCurrent()) return;
        const raw = err instanceof Error ? err.message : "";
        toast.error(raw || `Couldn't select ${row.name}`);
      } finally {
        if (isCurrent()) setCreating(false);
      }
    },
    [onChange],
  );

  const mintAndSelect = useCallback(
    async (mint: {
      name: string;
      serverIds: string[];
      resolvedServerNames: string[];
      collision: string;
      failure: string;
    }) => {
      const isCurrent = sinceNow();
      let wrote = false;
      try {
        const result = (await createServerAttachment({
          projectId: project,
          name: mint.name,
          serverIds: mint.serverIds,
        })) as { _id: string };
        wrote = true;
        const created: EvalServerAttachment = {
          _id: result._id,
          name: mint.name,
          serverIds: mint.serverIds,
          // Positional, never compacted: the model documents these as parallel
          // to `serverIds`, and `isServerStandIn` reads index 0. Dropping a
          // gap shifts every later name onto the wrong id.
          resolvedServerNames: mint.resolvedServerNames,
        };
        if (!isCurrent()) throw { stale: true, wrote } as MintFailure;
        setPending((prev) => ({
          projectId: project,
          removed: prev.projectId === project ? prev.removed : [],
          added:
            prev.projectId === project ? [...prev.added, created] : [created],
        }));
        // Awaited: `onChange` is typed `=> void`, but bivariance lets a caller
        // pass an async commit — the suite bar passes an awaited `updateSuite`
        // — and an un-awaited rejection escapes this catch entirely.
        await onChange(result._id, created);
        // Re-checked AFTER the commit too: skipping the close but resolving
        // still tells the panel this succeeded, and it clears a draft that now
        // belongs to the next project.
        if (!isCurrent()) throw { stale: true, wrote } as MintFailure;
        setOpen(false);
      } catch (err) {
        if ((err as MintFailure)?.stale) throw err;
        if (!isCurrent()) throw { stale: true, wrote } as MintFailure;
        const raw = err instanceof Error ? err.message : "";
        // The collision wording belongs to the WRITE: matched against the
        // caller's commit error it told the user to rename a group that had
        // just been written, and a rename writes a second one.
        toast.error(
          !wrote && /already exists/i.test(raw)
            ? mint.collision
            : raw || mint.failure,
        );
        throw { wrote } as MintFailure;
      }
    },
    [createServerAttachment, onChange, project],
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
      const isCurrent = sinceNow();
      try {
        const existing = findSoloGroup(attachments, serverId);
        if (existing) {
          await selectExisting(existing);
          return;
        }

        const server = catalog.find((row) => row._id === serverId);
        if (!server) return;

        setCreating(true);
        try {
          await mintAndSelect({
            name: deriveServerGroupName(
              [server.name],
              attachments.map((a) => a.name ?? ""),
            ),
            serverIds: [serverId],
            resolvedServerNames: [server.name],
            collision: `A server group named after "${server.name}" already exists.`,
            failure: `Couldn't select ${server.name}`,
          });
        } catch {
          // Already reported, or the project moved on. Either way this click
          // has nothing left to do.
        } finally {
          if (isCurrent()) setCreating(false);
        }
      } finally {
        if (isCurrent()) writing.current = false;
      }
    },
    [
      attachments,
      attachmentsKnown,
      catalog,
      createServerAttachment,
      creating,
      onChange,
      project,
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
       * THROWN, so the panel keeps the draft; resolving would discard what the
       * user picked while the submit that owns it is still in flight. And SAID
       * first, because the panel's catch reports nothing.
       */
      if (writing.current) {
        toast.error("Still saving the last change — try again in a moment.");
        throw new Error("A write is already in flight");
      }
      writing.current = true;
      setCreating(true);
      const isCurrent = sinceNow();
      // Same split as the bare-server path: the collision wording is the
      // WRITE's, not the caller's commit's.
      const byId = new Map(catalog.map((row) => [row._id, row.name]));
      try {
        await mintAndSelect({
          name,
          serverIds,
          resolvedServerNames: serverIds.map((id) => byId.get(id) ?? ""),
          collision: `A server group named "${name}" already exists.`,
          failure: "Failed to create server group",
        });
      } catch (err) {
        const fail = err as MintFailure;
        // A rejection tells the panel to keep the draft: right when the row
        // did not land, and when the project moved on. Not
        // when the row landed: the next Create would mint a duplicate.
        if (fail?.stale || !fail?.wrote) throw err;
      } finally {
        if (isCurrent()) {
          setCreating(false);
          writing.current = false;
        }
      }
    },
    [attachmentsKnown, catalog, createServerAttachment, onChange, project],
  );

  /** The panel supplies the picked servers; this supplies the taken names. */
  const deriveName = useCallback(
    (pickedServerNames: string[]) =>
      /**
       * One server takes the NUMBERED name: its own IS the stand-in shape, so
       * suggesting it would hide the group being made. Hence the empty list.
       * Unclosable gap: a server literally called `group` makes every
       * `Group N` read as its stand-in. That wants the storage column.
       */
      deriveServerGroupName(
        pickedServerNames.length === 1 ? [] : pickedServerNames,
        attachments.map((a) => a.name ?? ""),
      ),
    [attachments],
  );

  /**
   * Remove a group. The only caller of this mutation in the app: without it a
   * project accumulates stand-ins nothing can clear.
   *
   * The backend refuses a group a suite still uses and says which; that
   * message is worth more than anything phrased here, so it is passed through.
   */
  const handleDeleteGroup = useCallback(
    async (groupId: string) => {
      if (writing.current || creating) return;
      // Deleting what the parent stores, with no way to tell it, leaves that
      // id pointing at nothing while the surface keeps launching against it.
      if (value === groupId && !onClearSelection) {
        toast.error("Pick a different server first — this one is in use here.");
        return;
      }
      writing.current = true;
      setCreating(true);
      const isCurrent = sinceNow();
      try {
        await deleteServerAttachment({ serverAttachmentId: groupId });
        // Both halves: minted-and-deleted in one sitting was never in the
        // query, and one the query still returns stays clickable until refetch.
        if (!isCurrent()) return;
        setPending((prev) => {
          const mine = prev.projectId === project;
          const removed = mine ? prev.removed : [];
          return {
            projectId: project,
            added: mine ? prev.added.filter((row) => row._id !== groupId) : [],
            removed: removed.includes(groupId)
              ? removed
              : [...removed, groupId],
          };
        });
        if (value === groupId) onClearSelection?.();
      } catch (err) {
        if (!isCurrent()) return;
        const raw = err instanceof Error ? err.message : "";
        toast.error(raw || "Couldn't delete that server group.");
      } finally {
        if (isCurrent()) {
          setCreating(false);
          writing.current = false;
        }
      }
    },
    [creating, deleteServerAttachment, onClearSelection, project, value],
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
      const isCurrent = sinceNow();
      try {
        await selectExisting(group);
      } finally {
        if (isCurrent()) writing.current = false;
      }
    },
    [attachments, creating, selectExisting],
  );

  // A dangling selection still reads as the empty label; surfacing it is its
  // own change. While the list is UNKNOWN every selection resolves as
  // dangling, so the empty label would assert "nothing picked" over a live one.
  const triggerLabel = resolved
    ? resolved.label
    : !attachmentsKnown && value
      ? "Loading…"
      : emptyTriggerLabel;

  // Bound once: the trigger's class groups and the wrapper below all ask the
  // same question, and four copies of it can drift apart.
  const field = variant === "field";

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Reopening lands on the tab that holds the current selection.
        if (next) setTab(initialPickerTab(selection));
      }}
    >
      {/* Who arranges the trigger and its clear control. A `field` trigger is
          `w-full`, and its only caller stacks it in a `space-y-2` column — as
          two loose children the X wrapped onto the line below the field. The
          pill needs no box: every caller already puts it in a flex row, and
          adding one would change their spacing, so `contents` keeps it
          exactly as loose as it was. */}
      <div className={field ? "flex w-full items-center" : "contents"}>
        <PopoverTrigger asChild>
          <button
            type="button"
            // `creating` too: clicking the trigger mid-write closed the popover
            // out from under the very write `busy` freezes everything else for.
            disabled={disabled || creating}
            id={triggerId}
            data-testid={triggerTestId ?? "server-picker-trigger"}
            className={cn(
              "flex items-center gap-1.5 border text-foreground",
              "outline-none transition-colors",
              field
                ? "h-9 w-full rounded-md px-3 shadow-xs focus-visible:ring-[3px] focus-visible:ring-ring/50"
                : "h-8 max-w-[260px] shrink-0 rounded-full px-2.5",
              field
                ? "border-input bg-transparent hover:bg-muted/30"
                : resolved
                  ? "border-border/60 bg-muted/40 hover:bg-muted/60"
                  : "border-dashed border-border/60 bg-muted/30 hover:bg-muted/45",
              disabled && "cursor-not-allowed opacity-50",
            )}
          >
            <Server
              className={cn(
                "shrink-0 text-muted-foreground",
                field ? "size-4" : "size-3.5",
              )}
            />
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                field
                  ? cn(
                      "text-left text-sm",
                      !resolved && "text-muted-foreground",
                    )
                  : "text-xs font-medium",
              )}
            >
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
        {onClearSelection && selection && attachmentsKnown && !busy ? (
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
      </div>

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
          // Its draft and `submitting` belong to the project it was opened in.
          key={project}
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
          // Without a way to tell the parent, deleting the row it is storing
          // is refused — so the control is withheld rather than offered and
          // then denied.
          canDeleteSelected={Boolean(onClearSelection)}
        />
      </PopoverContent>
    </Popover>
  );
}
