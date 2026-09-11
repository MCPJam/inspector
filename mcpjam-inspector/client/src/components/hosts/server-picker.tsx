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
  /**
   * The project these writes were made against. Carried WITH them so a render
   * for another project discards the overlay by DERIVATION — an effect clears
   * it one render too late, and that render is the one offering the old
   * project's rows.
   */
  projectId: string;
  added: EvalServerAttachment[];
  removed: string[];
};

const NO_PENDING: PendingWrites = { projectId: "", added: [], removed: [] };

/** How `mintAndSelect` reports a write that failed, or one the project left behind. */
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
  /**
   * `id` for the trigger, so a sibling `<Label htmlFor>` names the control.
   * Without it the accessible name is only the selected group — "Stripe",
   * never "Server".
   */
  triggerId?: string;
  /**
   * Trigger shape. `pill` (default) is the compact chip the bars and
   * lego-strips use. `field` renders a full-width, `h-9` form control that
   * lines up with an `<Input>`/`<Select>` in a labelled form column — used by
   * the promote-to-test-case modal, where Client and Server sit side by side
   * and a chip next to a select reads as a different kind of control.
   *
   * Shape only: the popover, the tabs, and the inline create form are
   * identical in both. The empty LABEL is too — the old picker keyed that off
   * the variant because its chip copy read as a broken placeholder in a form,
   * and BB-142 deleted that copy.
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
   * Trimmed ONCE, and used for everything downstream. The hooks query on the
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
   * Servers whose handshake this picker started and has not seen settle.
   *
   * `canConnect` reads the RUNTIME status, which does not flip to `connecting`
   * until the provider says so — and until then every click starts another
   * `ensureServersReady` for the same server. A set, not one name: connecting
   * two different servers at once is a thing a user may reasonably do.
   */
  const [connecting, setConnecting] = useState<readonly string[]>([]);

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
  const [storedPending, setPending] = useState<PendingWrites>(NO_PENDING);

  /** The overlay, but only when it belongs to the project being rendered. */
  const pending =
    storedPending.projectId === project ? storedPending : NO_PENDING;

  /**
   * What a completing write must still be looking at.
   *
   * A GENERATION, not the project id: leaving A for B and coming back makes a
   * stale completion's id match again, and it would then report a selection
   * the user made two screens ago. The counter only ever goes up, so a write
   * that started in an earlier visit can never look current.
   */
  const generation = useRef(0);
  // Advanced from a COMMITTED effect, never during render: React can discard
  // an interrupted render, and a bump from one would strand a write started
  // by the tree that actually committed. Each handler reads the counter when
  // it begins and compares after every await.
  // LAYOUT effect: a passive one runs after paint, and a mutation resolving in
  // that gap would still read the old generation as current — accepting a
  // completion for the project the user just left.
  useLayoutEffect(() => {
    generation.current += 1;
    // Handshakes belong to the project they were started in. Keyed by NAME,
    // so carrying them across would withhold Connect from a same-named server
    // in the next project. The in-flight one still settles; its `finally`
    // filters a list that no longer holds it, which is a no-op.
    setConnecting([]);
  }, [project]);
  // Unmount is a project change too, as far as a write in flight is concerned:
  // LAYOUT, so the bump lands in the unmount commit — a passive cleanup runs
  // after it, and a promise settling in that gap still read the generation as
  // current.
  // without this, a handshake completing after the user navigated away still
  // toasted and still wrote state. Its own effect, because a cleanup on the
  // one above would also fire on every project change — where the body has
  // already done the bump.
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
   * NOT covered by a test, and that is not an oversight. Every path that takes
   * this ref now also raises `creating`, so `busy` disables the control and
   * jsdom — which flushes a discrete event synchronously — never fires the
   * second click. The window this closes is the one before that flush, and it
   * is unreachable from a DOM test, which is also why the practical risk
   * through a mouse is small. Deleting this because "no test fails" would be
   * reading that backwards.
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
    // Rows written before `resolvedServerNames` existed arrive without it, and
    // the model treats a row it cannot judge as a group — so a legacy
    // stand-in was never reused and every pick of that server minted another.
    // The catalog holds the names; use them.
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
   * `ensureServersReady` runs with `allowInteractiveOAuthFlow: false`, so a
   * server needing consent returns in `reauthServerNames` rather than popping
   * a window. Success needs no toast — the dot turns green on its own.
   */
  const handleConnect = useCallback(
    async (serverName: string) => {
      if (!actions) return;
      // Fenced like every other awaited path. Clearing `connecting` on the
      // switch re-exposes the row, but this handshake still settles — and its
      // cleanup would then drop the NEW project's entry for a same-named
      // server, re-offering Connect while that one is still pending. Its
      // toasts belong to a screen the user has left, too.
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
   * Both hooks flatten `undefined` to an empty list, so "in flight" and
   * "answered, and empty" arrive identically. `isLoading` is the only thing
   * that separates them — and it is false for a SKIPPED query, which
   * `catalogRows === undefined` is not: `useProjectServers` skips for a local
   * or UUID project id, where reading undefined as in-flight would leave the
   * tab loading for ever.
   */
  /**
   * …and a query that never RAN is not an answer either. Both hooks skip until
   * `isUserReady`, and a skipped query reports `isLoading: false` with an empty
   * list — so during the DB-user bootstrap this read "answered, and empty",
   * marked a live selection dangling and told the user the project has no
   * servers. That is the BB-182 defect one layer up.
   *
   * Answered by the hooks that own the skip, not re-derived here: the picker
   * has no business knowing WHY a query did not run, and reaching for the
   * bootstrap context directly made this component break every test that
   * mocks that module without the new export.
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
      if (prev.projectId !== project) return prev;
      return added.length === prev.added.length &&
        removed.length === prev.removed.length
        ? prev
        : { ...prev, added, removed };
    });
  }, [serverAttachments, attachmentsKnown, pending, project]);

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
   * Write a `serverAttachments` row, record it locally, and report it as the
   * selection.
   *
   * Both write paths did this identically — the same pending merge, the same
   * awaited commit, the same close, the same `wrote`-gated collision wording —
   * so a fix to one was easy to miss in the other.
   *
   * Throws `{ wrote }` on failure, after saying so: `wrote` tells the caller
   * whether the row landed, which is what decides if a retry would duplicate
   * it. Throws `{ stale: true }` when the project changed mid-flight — not a
   * failure to report, but it must not RESOLVE either, or the panel reads it
   * as success and clears a draft that now belongs to another project.
   */
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
      try {
        const existing = findSoloGroup(attachments, serverId);
        if (existing) {
          // AWAITED, like both mint paths. `onChange` is typed `=> void`, but
          // bivariance lets a caller pass an async commit, and returning here
          // before it settles releases the latch in the `finally` below while
          // the parent is still writing — reopening the very window the latch
          // was taken to close.
          //
          // And `creating` goes up for the wait, so `busy` does too. Holding
          // only the ref left every control enabled while the latch refused
          // them: a dead control, which is the thing `busy` exists to prevent.
          // It also arms `onInteractOutside`, so a click away cannot dismiss
          // the popover out from under a commit in flight.
          setCreating(true);
          const isCurrent = sinceNow();
          try {
            await onChange(existing._id, existing as EvalServerAttachment);
            if (isCurrent()) setOpen(false);
          } catch (err) {
            const raw = err instanceof Error ? err.message : "";
            toast.error(raw || `Couldn't select ${existing.name}`);
          } finally {
            setCreating(false);
          }
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
        // The panel reads a rejection as "keep the draft". Keep it when the
        // row did NOT land (a retry is the fix) and when the project moved on
        // (resolving would clear a draft that is now someone else's). Not
        // when the row landed: the next Create would mint a duplicate.
        if (fail?.stale || !fail?.wrote) throw err;
      } finally {
        setCreating(false);
        writing.current = false;
      }
    },
    [attachmentsKnown, catalog, createServerAttachment, onChange, project],
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
      const isCurrent = sinceNow();
      try {
        await deleteServerAttachment({ serverAttachmentId: groupId });
        // Both halves, in one move: drop it from `added` (a row minted and
        // deleted in one sitting was never in the query to begin with) and
        // record it in `removed` (a row the query still returns would
        // otherwise sit on the tab, and stay clickable, until the refetch).
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
        const raw = err instanceof Error ? err.message : "";
        toast.error(raw || "Couldn't delete that server group.");
      } finally {
        setCreating(false);
        writing.current = false;
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
      // Visible for the same reason as the bare-server reuse path: the wait
      // belongs on screen, not only in a ref nobody can see.
      setCreating(true);
      const isCurrent = sinceNow();
      try {
        await onChange(group._id, group as EvalServerAttachment);
        if (isCurrent()) setOpen(false);
      } catch (err) {
        const raw = err instanceof Error ? err.message : "";
        toast.error(raw || `Couldn't select ${group.name}`);
      } finally {
        setCreating(false);
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
          // `creating` too: clicking the trigger mid-write closed the popover
          // out from under the very write `busy` freezes everything else for.
          disabled={disabled || creating}
          id={triggerId}
          data-testid={triggerTestId ?? "server-picker-trigger"}
          className={cn(
            "flex items-center gap-1.5 border text-foreground",
            "outline-none transition-colors",
            variant === "field"
              ? "h-9 w-full rounded-md px-3 shadow-xs focus-visible:ring-[3px] focus-visible:ring-ring/50"
              : "h-8 max-w-[260px] shrink-0 rounded-full px-2.5",
            variant === "field"
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
              variant === "field" ? "size-4" : "size-3.5",
            )}
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              variant === "field"
                ? cn("text-left text-sm", !resolved && "text-muted-foreground")
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
          // Without a way to tell the parent, deleting the row it is storing
          // is refused — so the control is withheld rather than offered and
          // then denied.
          canDeleteSelected={Boolean(onClearSelection)}
        />
      </PopoverContent>
    </Popover>
  );
}
