import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  AlertTriangle,
  PenLine,
  Pencil,
  Trash2,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { DetailPageHeader } from "@/components/shared/detail-page-header";
import { ChatboxShareSection } from "@/components/chatboxes/ChatboxShareSection";
import { ChatboxUsagePanel } from "@/components/chatboxes/ChatboxUsagePanel";
import { InsightsWorkbench } from "@/components/shared/usage-insights/InsightsWorkbench";
import { RunInsightsChip } from "@/components/shared/usage-insights/run-insights";
import { withHideSynthetic } from "@/components/chatboxes/user-testing-traffic";
import {
  parseSelectionParam,
  serializeSelectionParam,
  type ThemeRef,
} from "@/hooks/chatbox-usage-filters";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { usePromoteCapability } from "@/hooks/usePromoteCapability";
import { ChatboxPreviewPane } from "@/components/chatboxes/ChatboxPreviewPane";
import { ChatboxDeleteConfirmDialog } from "@/components/chatboxes/ChatboxDeleteConfirmDialog";
import { EditableTitle } from "@/components/evals/EditableTitle";
import { EnvironmentComposer } from "@/components/environment-composer/environment-composer";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  composerStateFromEnvironments,
  composerHasTarget,
  emptyComposerState,
  type EnvironmentComposerState,
} from "@/components/environment-composer/environment-stack";
import { isAdhocUnavailable } from "@/components/environment-composer/resolve-stacks";
import { useComposerResolver } from "@/components/environment-composer/use-composer-resolver";
import { NameEnvironmentDialog } from "@/components/project-environments/NameEnvironmentDialog";
import { TextareaAutosize } from "@/components/ui/textarea-autosize";
import {
  useChatboxMutations,
  type ChatboxSettings,
} from "@/hooks/useChatboxes";
import { useHost } from "@/hooks/useClients";
import {
  useProjectEnvironment,
  useProjectEnvironments,
} from "@/hooks/useProjectEnvironments";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import { isAdhocEnvironment } from "@/lib/environment-label";
import { convexErrMessage } from "@/lib/convex-error";
import {
  buildUserTestingScenarioPath,
  parseUserTestingDetailTab,
  type UserTestingDetailTab,
} from "@/lib/app-navigation";
import { buildChatboxLink } from "@/lib/chatbox-session";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * One User Testing scenario: compact detail chrome (title + actions + tabs),
 * then tab bodies for edit/setup and what came back from testers.
 *
 * Edit is a docked split — setup/share on the left, live Preview on the right
 * (the old Humans share-next-to-preview layout). Preview embeds the live share
 * link, which means opening Edit starts a REAL guest session against this
 * scenario — it shows up in Sessions and in guest analytics like any tester's.
 * That's why Preview mounts lazily (opening a scenario costs nothing) and why
 * the embed tags itself `?surface=preview` (so the session it starts is
 * labelled rather than passing for a tester's).
 *
 * Insights are per-scenario for free — `ChatboxUsagePanel` is chatbox-scoped,
 * so the topic map here only ever covers this scenario's own sessions. There is
 * deliberately no project-wide insights view: aggregating across scenarios that
 * point at different servers would produce themes nobody can act on.
 */
interface UserTestingScenarioDetailProps {
  chatbox: ChatboxSettings;
  /** Gates the host query behind Preview's iframe permissions. */
  isAuthenticated: boolean;
  onBack: () => void;
  /** Parent returns to the list. */
  onDeleted: () => void;
}

const TAB_OPTIONS: ReadonlyArray<{
  value: UserTestingDetailTab;
  label: string;
}> = [
  { value: "edit", label: "Edit" },
  { value: "sessions", label: "Sessions" },
  { value: "insights", label: "Insights" },
];

export function UserTestingScenarioDetail({
  chatbox,
  isAuthenticated,
  onBack,
  onDeleted,
}: UserTestingScenarioDetailProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { deleteChatbox, updateChatbox, rebindEnvironmentChatbox } =
    useChatboxMutations();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [nameEnvironmentOpen, setNameEnvironmentOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);

  // The environment row itself — for `origin` and `revision`, which the
  // chatbox settings envelope deliberately doesn't carry. Host-backed
  // scenarios (no environmentId) skip the query entirely, and so does a
  // project without `project-environments-enabled`: promotion's whole payoff
  // is "now manage it from Environments", a surface that flag gates — offering
  // it flag-off would mutate a row the user then has no page to see. NOTE:
  // `chatbox.environmentName` is non-null even for an ad-hoc row (the backend
  // synthesizes a label from the client name), so ad-hoc-ness must come from
  // this row, never from name presence on the envelope.
  const environmentsEnabled = useProjectEnvironmentsEnabled();
  const environment = useProjectEnvironment(
    environmentsEnabled && chatbox.environmentId ? chatbox.projectId : null,
    chatbox.environmentId ?? null,
  );
  // Fail closed: `undefined` (loading) and `null` (not visible) both hide the
  // promote affordance rather than guessing.
  const environmentIsAdhoc = Boolean(
    environment && isAdhocEnvironment(environment),
  );

  // ── Setup editor: the shared composer, committing through REBIND ────────
  //
  // The strip edits the scenario's execution context in place: each change
  // resolves the composition to a real environment row (ad-hoc get-or-create,
  // or a matching NAMED row) and re-points the chatbox at it. The environment
  // itself is never mutated — a named row may back suites and other runs, and
  // an ad-hoc row is immutable by construction. Session history stays with the
  // chatbox either way.
  const namedEnvironments = useProjectEnvironments(
    environmentsEnabled && chatbox.environmentId ? chatbox.projectId : null,
  );
  const liveNamedEnvironments = useMemo(
    () => (namedEnvironments ?? []).filter((env) => !env.archivedAt),
    [namedEnvironments],
  );
  const resolveComposerTargets = useComposerResolver(chatbox.projectId);
  const [composer, setComposer] = useState<EnvironmentComposerState>(
    emptyComposerState,
  );
  const [isRebinding, setIsRebinding] = useState(false);
  // Blocks the reseed below while a commit is in flight, so the rebind's own
  // reactive echo doesn't clobber the state the user is mid-editing against.
  const committingRef = useRef(false);
  // The environment the backend ACTUALLY points at, as far as this client
  // knows — advanced synchronously when a rebind succeeds, because the
  // reactive `chatbox.environmentId` echo lags the mutation. Comparing
  // against the prop instead let an immediate "change it back" edit read as
  // a no-op and get silently swallowed while the backend stayed on the FIRST
  // target.
  const committedEnvironmentIdRef = useRef<string | null>(
    chatbox.environmentId ?? null,
  );
  // Always the CURRENT reactive values, for the post-commit reconciliation
  // below: a subscription update that lands mid-commit is deliberately
  // skipped by both sync effects, and their deps have already settled by the
  // time the commit ends — clearing the guard alone never replays it. The
  // closure's own props are frozen at edit time, so it reads these instead.
  const latestEnvironmentIdRef = useRef<string | null>(
    chatbox.environmentId ?? null,
  );
  latestEnvironmentIdRef.current = chatbox.environmentId ?? null;
  const latestEnvironmentRowRef = useRef(environment);
  latestEnvironmentRowRef.current = environment;
  useEffect(() => {
    // Adopt remote rebinds (another member, or our own echo) — but never
    // mid-commit, when the ref is ahead of the subscription on purpose.
    if (committingRef.current) return;
    committedEnvironmentIdRef.current = chatbox.environmentId ?? null;
  }, [chatbox.environmentId]);
  useEffect(() => {
    if (!environment || committingRef.current) return;
    setComposer(composerStateFromEnvironments([environment]));
    // Keyed on identity + revision, not the (always-fresh) row object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environment?.environmentId, environment?.revision]);

  const composerActive = Boolean(
    environmentsEnabled && chatbox.environmentId && environment,
  );
  // Held closed until the NAMED list settles, like the create flow: the
  // resolver reuses a matching named environment, and resolving against an
  // empty not-yet-loaded list would mint an unnamed twin of one that exists.
  const composerReady = namedEnvironments !== undefined;

  const handleComposerChange = (next: EnvironmentComposerState) => {
    // One commit at a time: a second edit mid-flight would clear
    // `committingRef` out from under the first one's rollback. The strip is
    // disabled while committing, so this guard only closes the setState gap.
    if (committingRef.current) return;
    const previous = composer;
    setComposer(next);
    // No target (cleared clients / detached selection) commits nothing — the
    // scenario keeps its current environment until the state resolves again.
    if (!composerHasTarget(next)) return;
    void (async () => {
      committingRef.current = true;
      setIsRebinding(true);
      // What this commit is moving AWAY from — needed to tell a collaborator's
      // mid-flight rebind (a third id) apart from our own not-yet-echoed one.
      const startedFromId = committedEnvironmentIdRef.current;
      try {
        const resolved = await resolveComposerTargets({
          state: next,
          liveEnvironments: liveNamedEnvironments,
          max: 1,
        });
        const nextEnvironmentId = resolved.environmentIds[0];
        if (!nextEnvironmentId) {
          // Should be unreachable (a target implies one resolved id), but a
          // silent skip here would leave the strip showing a setup the
          // scenario does not run.
          setComposer(previous);
          toast.error("Could not resolve this setup to an environment.");
          return;
        }
        if (nextEnvironmentId !== committedEnvironmentIdRef.current) {
          await rebindEnvironmentChatbox({
            chatboxId: chatbox.chatboxId,
            environmentId: nextEnvironmentId,
          } as any);
          committedEnvironmentIdRef.current = nextEnvironmentId;
        }
      } catch (err) {
        // Roll back to what the scenario actually runs, then say why —
        // verbatim, because the refusals are instructions ("that setup
        // already has a scenario — …", "requires project admin").
        setComposer(previous);
        toast.error(
          isAdhocUnavailable(err)
            ? "This workspace's backend doesn't support editing a scenario's setup yet."
            : convexErrMessage(err, "Could not update this scenario's setup"),
        );
      } finally {
        committingRef.current = false;
        setIsRebinding(false);
        // Replay what the guard skipped. A subscription value that is neither
        // what this commit started from (our own echo still pending) nor what
        // it committed is a collaborator's rebind that landed mid-flight —
        // without this, a FAILED commit rolls back to a setup the backend no
        // longer points at, and the stale ref then swallows follow-up edits
        // as no-ops.
        const latest = latestEnvironmentIdRef.current;
        if (
          latest !== committedEnvironmentIdRef.current &&
          latest !== startedFromId
        ) {
          committedEnvironmentIdRef.current = latest;
          const row = latestEnvironmentRowRef.current;
          if (row && row.environmentId === latest) {
            setComposer(composerStateFromEnvironments([row]));
          }
          // If the row for `latest` hasn't loaded yet, the reseed effect
          // fires when it does — `committingRef` is already false.
        }
      }
    })();
  };

  // Draft state for the description, persisted on blur. Reseeded whenever the
  // reactive envelope changes so another member's edit doesn't get silently
  // overwritten by a stale draft on the next blur — but NOT while the field
  // holds focus. Two races live in that exception: our own save echoing back
  // after the user has already refocused and started the next edit, and a
  // collaborator's edit landing mid-sentence; both would otherwise replace
  // in-progress typing without a trace. The remote value skipped during focus
  // is picked up on blur instead (see `persistDescription`).
  const [descriptionDraft, setDescriptionDraft] = useState(
    chatbox.description ?? "",
  );
  const descriptionFocusedRef = useRef(false);
  useEffect(() => {
    if (descriptionFocusedRef.current) return;
    setDescriptionDraft(chatbox.description ?? "");
  }, [chatbox.description]);

  const handleRename = async (name: string) => {
    try {
      await updateChatbox({ chatboxId: chatbox.chatboxId, name } as any);
    } catch (err) {
      toast.error(convexErrMessage(err, "Failed to rename the scenario"));
      // Rethrow so EditableTitle reverts to the persisted name.
      throw err;
    }
  };

  const persistDescription = async () => {
    descriptionFocusedRef.current = false;
    const next = descriptionDraft.trim();
    if (next === (chatbox.description ?? "").trim()) {
      // No-op blur: resync the draft with the envelope, which also adopts any
      // remote value the focused-guard above deliberately skipped.
      setDescriptionDraft(chatbox.description ?? "");
      return;
    }
    try {
      await updateChatbox({
        chatboxId: chatbox.chatboxId,
        description: next,
      } as any);
    } catch (err) {
      toast.error(convexErrMessage(err, "Failed to save the description"));
      setDescriptionDraft(chatbox.description ?? "");
    }
  };

  // The URL is the stash for both the tab and the opened session: the gates
  // above remount this route during a cold boot, so state captured on first
  // mount wouldn't survive to the last one.
  const tab = parseUserTestingDetailTab(location.search);
  const searchParams = new URLSearchParams(location.search);
  const sessionParam = searchParams.get("session");
  const sessionDeepLinkThreadId = sessionParam;
  // Insights selection + which diagram it was made on, so a copied link
  // reopens exactly what the sender was looking at.
  const selParam = searchParams.get("sel");
  const viewParam = searchParams.get("view");
  const urlSelection = useMemo(
    () => parseSelectionParam(selParam),
    [selParam],
  );

  // Requesting narration SPENDS, and dismissing a finding is a judgment that
  // outlives the viewer — both are member-gated server-side, while viewing
  // signals and findings is not. User Testing is deliberately guest-visible,
  // so the affordances gate rather than the surface. Same tier and same
  // identity paths as promotion, so the same resolver answers it.
  const { canPromote: canRequestInsights } = usePromoteCapability({
    projectId: chatbox.projectId ?? null,
  });

  // Present only when the environment can't resolve right now (archived, a
  // pinned plugin disabled, its host gone). The scenario still opens: its
  // sessions are history worth reading, and unpublishing it is the action
  // this state calls for.
  const environmentError = chatbox.environmentError ?? null;

  const publishLink = chatbox.link?.token
    ? buildChatboxLink(chatbox.link.token, chatbox.name)
    : null;

  // Edit docks the live Preview beside the setup form. Preview embeds the
  // share link and starts a real guest session, so the whole Edit tree
  // (including the iframe) mounts only once Edit has been opened — then
  // stays mounted and hidden when flipping to Sessions/Insights so returning
  // doesn't start a second session. Legacy `?tab=preview` parses as Edit.
  const [hasOpenedEdit, setHasOpenedEdit] = useState(tab === "edit");
  useEffect(() => {
    if (tab === "edit") setHasOpenedEdit(true);
  }, [tab]);

  // The preview's remount discriminator, FROZEN while Edit is hidden. The
  // frame must follow a rebind (same share link, different environment), but
  // the Edit tree stays mounted-hidden off-tab — remounting there would
  // silently start a fresh guest session nobody is looking at (a
  // collaborator's rebind can land on any tab). Adjusted during render, not
  // in an effect, so returning to Edit re-renders once with the fresh key
  // and mounts a single frame instead of mount-then-remount.
  const liveEnvironmentKey = chatbox.environmentId ?? "";
  const [previewEnvironmentKey, setPreviewEnvironmentKey] =
    useState(liveEnvironmentKey);
  if (tab === "edit" && previewEnvironmentKey !== liveEnvironmentKey) {
    setPreviewEnvironmentKey(liveEnvironmentKey);
  }

  // The host config sets the preview iframe's `allow` ceiling. Waiting for it
  // is about FIDELITY, not enforcement: the attribute only takes effect at
  // mount and its no-config default is permissive, so mounting early would
  // give a deny-all host a wider wrapper than it asked for. It is not a
  // security hole when the host doesn't resolve — the wrapper is a ceiling,
  // and the mcp-apps renderer INSIDE the frame re-reads the real host policy
  // and enforces it per resource (see `previewIframeAllow`). So a null host
  // still previews; only a genuinely pending one waits.
  // `useHost` reports a SKIPPED query as loading forever — treat it as
  // pending only when it can actually resolve.
  const previewHostId = chatbox.namedHostId ?? null;
  const { host: previewHost, isLoading: previewHostLoading } = useHost({
    isAuthenticated,
    hostId: previewHostId,
  });
  const isPreviewProfilePending =
    isAuthenticated && Boolean(previewHostId) && previewHostLoading;

  const goToTab = (next: UserTestingDetailTab) => {
    // Replace, not push: flipping a sub-tab shouldn't put a stop on the back
    // button between the scenario and the list. `session` and `sel` are
    // PRESERVED: both name something the user picked, and dropping them on a
    // tab flip loses the selection they came back to the other tab to see —
    // and makes the URL they copied stop describing what is on screen.
    navigate(
      buildUserTestingScenarioPath(chatbox.chatboxId, {
        tab: next,
        session: sessionParam ?? undefined,
        sel: selParam ?? undefined,
        view: viewParam ?? undefined,
      }),
      { replace: true },
    );
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await deleteChatbox({ chatboxId: chatbox.chatboxId } as any);
      toast.success("Scenario deleted");
      setDeleteOpen(false);
      onDeleted();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to delete the scenario",
      );
      // Rethrow: the dialog closes itself when `onConfirm` RESOLVES, so
      // swallowing here would dismiss the confirmation on a delete that
      // didn't happen and leave the user believing it did.
      throw err;
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <DetailPageHeader
        backLabel="User Testing"
        onBack={onBack}
        backTestId="user-testing-detail-back"
        title={
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <EditableTitle
              value={chatbox.name}
              onSave={handleRename}
              variant="h1"
              placeholder="Scenario name"
              className="-ml-2 shrink-0 px-2 text-xl font-semibold tracking-tight"
              inputClassName="min-w-[8rem] max-w-full text-xl font-semibold tracking-tight"
            />
            <TextareaAutosize
              aria-label="Scenario description"
              data-testid="user-testing-description"
              value={descriptionDraft}
              onChange={(e) => setDescriptionDraft(e.target.value)}
              onFocus={() => {
                descriptionFocusedRef.current = true;
              }}
              onBlur={() => void persistDescription()}
              minRows={1}
              maxRows={4}
              maxLength={2000}
              placeholder="Add a description…"
              className={cn(
                "min-h-0 min-w-[12rem] flex-1 resize-none border-0 bg-transparent px-0 py-0 text-sm",
                "text-muted-foreground shadow-none placeholder:text-muted-foreground/60",
                "focus-visible:border-0 focus-visible:ring-0",
              )}
            />
          </div>
        }
        tabs={{
          value: tab,
          options: TAB_OPTIONS,
          onChange: goToTab,
          ariaLabel: "Scenario view",
          indicatorId: "user-testing-detail",
        }}
      />

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {hasOpenedEdit ? (
          // Hidden rather than unmounted off-tab: the docked Preview iframe
          // starts a real guest session, and remounting would abandon it.
          <div
            className={cn(
              "absolute inset-0",
              tab === "edit" ? "" : "hidden",
            )}
            data-testid="user-testing-edit-tab"
            aria-hidden={tab === "edit" ? undefined : true}
          >
            <ResizablePanelGroup direction="horizontal" className="h-full">
              <ResizablePanel defaultSize={48} minSize={32}>
                <div className="h-full overflow-y-auto px-8 py-4">
                  {environmentError ? (
                    <div
                      data-testid="user-testing-detail-environment-error"
                      className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3"
                    >
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500" />
                      <div className="min-w-0 text-sm">
                        <p className="font-medium text-foreground">
                          {environmentError.code === "ENV_ARCHIVED"
                            ? "This scenario's environment is archived — the share link no longer opens."
                            : "This scenario's environment can't be loaded right now — the share link won't open."}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {environmentError.message} Its sessions are
                          unaffected.
                        </p>
                      </div>
                    </div>
                  ) : null}

                  <ChatboxShareSection chatbox={chatbox} />

                  <div className="mt-8 flex flex-wrap items-center gap-2 border-t border-border/40 pt-4">
                    {composerActive ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="rounded-lg"
                        disabled={isRebinding}
                        onClick={() => setSetupOpen(true)}
                        data-testid="user-testing-edit-setup"
                      >
                        <Pencil className="mr-1.5 size-4" />
                        Edit
                      </Button>
                    ) : null}
                    <Button
                      variant="outline"
                      size="sm"
                      className="rounded-lg text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setDeleteOpen(true)}
                      data-testid="user-testing-delete"
                    >
                      <Trash2 className="mr-1.5 size-4" />
                      Delete scenario
                    </Button>
                  </div>
                </div>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={52} minSize={30}>
                <div
                  className="flex h-full min-h-0 flex-col border-l border-border/40"
                  data-testid="user-testing-edit-preview"
                >
                  <div className="flex h-9 shrink-0 items-center border-b border-border/40 px-4">
                    <p className="text-sm font-medium text-foreground">
                      Preview
                    </p>
                  </div>
                  <div className="relative min-h-0 flex-1">
                    {isPreviewProfilePending ? (
                      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                        Loading preview…
                      </div>
                    ) : (
                      <ChatboxPreviewPane
                        publishLink={environmentError ? null : publishLink}
                        mcpProfile={previewHost?.config.mcpProfile}
                        // A rebind repoints this scenario at a different
                        // environment without touching the share link, so the
                        // frame would keep testing the pre-rebind setup.
                        // Follows `chatbox.environmentId` (reactive) while
                        // Edit is visible; frozen off-tab — see the state
                        // above.
                        remountKey={previewEnvironmentKey}
                        emptyTitle={
                          environmentError
                            ? "This scenario can't be previewed"
                            : undefined
                        }
                        emptyBody={
                          environmentError
                            ? `${environmentError.message} Its sessions are unaffected.`
                            : undefined
                        }
                      />
                    )}
                  </div>
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
        ) : null}
        {tab === "sessions" ? (
          <div className="absolute inset-0">
            <ChatboxUsagePanel
              chatbox={chatbox}
              initialThreadId={sessionDeepLinkThreadId}
            />
          </div>
        ) : null}
        {tab === "insights" ? (
          <div className="absolute inset-0">
            <InsightsWorkbench
              scope={{ kind: "chatbox", chatboxId: chatbox.chatboxId }}
              cohortKey={chatbox.chatboxId}
              // Scenarios carry real-user traffic; the retired simulation
              // flow's rows are still in the database and stay hidden.
              augmentFilter={withHideSynthetic}
              urlSelection={urlSelection}
              onSelectionChange={(themes) => {
                navigate(
                  buildUserTestingScenarioPath(chatbox.chatboxId, {
                    tab: "insights",
                    session: sessionParam ?? undefined,
                    sel: themes
                      ? serializeSelectionParam(themes as ThemeRef[])
                      : undefined,
                    view: viewParam ?? undefined,
                  }),
                  { replace: true },
                );
              }}
              initialView={viewParam === "clusters" ? "clusters" : "flow"}
              onViewChange={(view) => {
                navigate(
                  buildUserTestingScenarioPath(chatbox.chatboxId, {
                    tab: "insights",
                    session: sessionParam ?? undefined,
                    sel: selParam ?? undefined,
                    view,
                  }),
                  { replace: true },
                );
              }}
              onOpenSession={(threadId) => {
                // Stash the target in the URL, then flip the tab — the same
                // reason the tab itself lives there.
                navigate(
                  buildUserTestingScenarioPath(chatbox.chatboxId, {
                    session: threadId,
                  }),
                  { replace: true },
                );
              }}
              onOpenSessionsTab={() => {
                navigate(buildUserTestingScenarioPath(chatbox.chatboxId), {
                  replace: true,
                });
              }}
              strugglesSlot={
                // Ships dark and guest-tolerant: `useQuery` against an
                // undeployed query throws, and a guest hitting the
                // member-only request mutation would too. The boundary makes
                // both render as nothing rather than as a broken tab — the
                // same pattern `ChatboxSessionsMetricStrip` uses.
                <ErrorBoundary fallback={null}>
                  <RunInsightsChip
                    surface={{
                      kind: "chatbox",
                      chatboxId: chatbox.chatboxId,
                    }}
                    onOpenSession={(threadId) => {
                      navigate(
                        buildUserTestingScenarioPath(chatbox.chatboxId, {
                          session: threadId,
                        }),
                        { replace: true },
                      );
                    }}
                    canRequest={canRequestInsights}
                    canDismiss={canRequestInsights}
                  />
                </ErrorBoundary>
              }
              // Parity with the swarm one-shot: a scenario analyzed before the
              // topic map existed backfills silently on first Clusters view.
              // The server mutation dedupes in-flight runs.
              autoBackfillTopicMap
              emptyState={
                <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                  <p className="text-sm text-muted-foreground">
                    No tester sessions yet — share the link to start collecting
                    them.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => goToTab("edit")}
                  >
                    Open Edit to share
                  </Button>
                </div>
              }
              className="px-8 py-4"
              testIdPrefix="chatbox-insights"
            />
          </div>
        ) : null}
      </div>

      <ChatboxDeleteConfirmDialog
        entityLabel="scenario"
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        chatboxName={chatbox.name}
        isDeleting={isDeleting}
        onConfirm={handleDelete}
      />

      {environment ? (
        <NameEnvironmentDialog
          open={nameEnvironmentOpen}
          onOpenChange={setNameEnvironmentOpen}
          projectId={chatbox.projectId}
          environment={environment}
        />
      ) : null}

      {composerActive ? (
        <Dialog open={setupOpen} onOpenChange={setSetupOpen}>
          <DialogContent
            className="sm:max-w-xl"
            aria-describedby={undefined}
            data-testid="user-testing-setup-dialog"
          >
            <DialogHeader>
              <DialogTitle>Edit setup</DialogTitle>
            </DialogHeader>
            <div className="min-w-0">
              <EnvironmentComposer
                projectId={chatbox.projectId}
                environments={liveNamedEnvironments}
                value={composer}
                onChange={handleComposerChange}
                maxTargets={1}
                disabled={isRebinding || !composerReady}
                inModal
                testIdPrefix="user-testing-detail"
                environmentPickerFooter={
                  environmentIsAdhoc ? (
                    // The row behind this setup is ad-hoc: content-addressed,
                    // immutable, labeled by its client rather than a name.
                    // Saving it (in place, same id) turns it into a curated
                    // environment other surfaces can pick.
                    <button
                      type="button"
                      onClick={() => setNameEnvironmentOpen(true)}
                      data-testid="user-testing-save-as-environment"
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    >
                      <PenLine className="size-3.5 shrink-0" />
                      Save as environment
                    </button>
                  ) : null
                }
              />
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
