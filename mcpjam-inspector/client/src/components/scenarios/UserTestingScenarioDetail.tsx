import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import {
  AlertTriangle,
  ExternalLink,
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
import {
  ScenarioShareBanner,
  ScenarioShareEmptyPanel,
} from "@/components/scenarios/ScenarioShareBanner";
import { ScenarioShareSection } from "@/components/scenarios/ScenarioShareSection";
import { ScenarioPerTurnFeedbackToggle } from "@/components/scenarios/ScenarioPerTurnFeedbackToggle";
import { ScenarioUsagePanel } from "@/components/scenarios/ScenarioUsagePanel";
import { InsightsWorkbench } from "@/components/shared/usage-insights/InsightsWorkbench";
import {
  RunInsightsProvider,
  RunInsightsRecommendations,
} from "@/components/shared/usage-insights/run-insights";
import { withHideSynthetic } from "@/components/scenarios/user-testing-traffic";
import {
  parseSelectionParam,
  serializeSelectionParam,
} from "@/hooks/scenario-usage-filters";
import type { InsightsView } from "@/hooks/useInsightsFlowController";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { ScenarioPreviewPane } from "@/components/scenarios/ScenarioPreviewPane";
import { ScenarioDeleteConfirmDialog } from "@/components/scenarios/ScenarioDeleteConfirmDialog";
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
  useScenarioMutations,
  type ScenarioSettings,
} from "@/hooks/useScenarios";
import { useHost } from "@/hooks/useClients";
import {
  useProjectEnvironment,
  useProjectEnvironments,
} from "@/hooks/useProjectEnvironments";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import { isAdhocEnvironment } from "@/lib/environment-label";
import { convexErrMessage } from "@/lib/convex-error";
import { ScenarioGradingSection } from "./ScenarioGradingSection";
import {
  buildUserTestingScenarioEditPath,
  buildUserTestingScenarioPath,
  isLegacyUserTestingEditTab,
  parseUserTestingDetailTab,
  type UserTestingDetailTab,
  useAppNavigate,
} from "@/lib/app-navigation";
import { buildScenarioLink } from "@/lib/scenario-session";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { ActionableFindings } from "@/components/shared/actionable-insights/actionable-findings";

/**
 * One User Testing scenario.
 *
 * Detail (`/user-testing/:id`): Insights | Sessions, share banner, Edit /
 * Open preview in the header. Edit (`/user-testing/:id/edit`): setup, full
 * share controls, and a docked live Preview. Preview embeds the share link,
 * so opening Edit starts a REAL guest session — it shows up in Sessions.
 * The embed tags itself `?surface=preview` so that session is labelled.
 *
 * Insights are per-scenario — `ScenarioUsagePanel` is scenario-scoped. There is
 * deliberately no project-wide insights view: aggregating across scenarios that
 * point at different servers would produce themes nobody can act on.
 */
interface UserTestingScenarioDetailProps {
  scenario: ScenarioSettings;
  /** Gates the host query behind Preview's iframe permissions. */
  isAuthenticated: boolean;
  /** `/user-testing/:id/edit` — setup / share / preview, no detail tabs. */
  editMode?: boolean;
  onBack: () => void;
  /** Parent returns to the list. */
  onDeleted: () => void;
}

const TAB_OPTIONS: ReadonlyArray<{
  value: UserTestingDetailTab;
  label: string;
}> = [
  { value: "insights", label: "Insights" },
  { value: "sessions", label: "Sessions" },
];

export function UserTestingScenarioDetail({
  scenario,
  isAuthenticated,
  editMode = false,
  onBack,
  onDeleted,
}: UserTestingScenarioDetailProps) {
  const navigate = useAppNavigate();
  const location = useLocation();
  const { deleteScenario, updateScenario, rebindEnvironmentScenario } =
    useScenarioMutations();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [nameEnvironmentOpen, setNameEnvironmentOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);

  // The environment row itself — for `origin` and `revision`, which the
  // scenario settings envelope deliberately doesn't carry. Host-backed
  // scenarios (no environmentId) skip the query entirely.
  //
  // NOT gated on `project-environments-enabled` any more. Editing the setup is
  // the thing this row unlocks, and a flag-off scenario is exactly the one that
  // needs it: it was created with a single server and had no other way to
  // change it, because its backing client is hidden from every client surface
  // (`isPrivateScenarioBackingHost`). The flag still gates PROMOTION — "Save as
  // environment" would mutate a row into a list the user has no page for — and
  // it gates itself, because the promote affordance rides in the environment
  // picker's footer and the picker only renders behind the flag.
  //
  // NOTE: `scenario.environmentName` is non-null even for an ad-hoc row (the
  // backend synthesizes a label from the client name), so ad-hoc-ness must come
  // from this row, never from name presence on the envelope.
  const environmentsEnabled = useProjectEnvironmentsEnabled();
  const environment = useProjectEnvironment(
    scenario.environmentId ? scenario.projectId : null,
    scenario.environmentId ?? null,
  );
  // Fail closed: `undefined` (loading) and `null` (not visible) both hide the
  // promote affordance rather than guessing.
  const environmentIsAdhoc = Boolean(
    environment && isAdhocEnvironment(environment),
  );
  // Promotion needs somewhere to promote TO. Stated here rather than resting on
  // "the footer rides in a picker the flag already hides": that is true today
  // and is not the rule — the rule is that naming a row the user has no page
  // for is a dead end.
  const canPromoteEnvironment = environmentIsAdhoc && environmentsEnabled;

  // ── Setup editor: the shared composer, committing through REBIND ────────
  //
  // The strip edits the scenario's execution context in place: each change
  // resolves the composition to a real environment row (ad-hoc get-or-create,
  // or a matching NAMED row) and re-points the scenario at it. The environment
  // itself is never mutated — a named row may back suites and other runs, and
  // an ad-hoc row is immutable by construction. Session history stays with the
  // scenario either way.
  //
  // Still queried flag-off: the resolver reuses a matching NAMED row rather
  // than minting an ad-hoc twin of it, and a flag-off project can hold named
  // rows that Swarms created.
  const namedEnvironments = useProjectEnvironments(
    scenario.environmentId ? scenario.projectId : null,
  );
  const liveNamedEnvironments = useMemo(
    () => (namedEnvironments ?? []).filter((env) => !env.archivedAt),
    [namedEnvironments],
  );
  const resolveComposerTargets = useComposerResolver(scenario.projectId);
  const [composer, setComposer] =
    useState<EnvironmentComposerState>(emptyComposerState);
  const [isRebinding, setIsRebinding] = useState(false);
  // Blocks the reseed below while a commit is in flight, so the rebind's own
  // reactive echo doesn't clobber the state the user is mid-editing against.
  const committingRef = useRef(false);
  // The environment the backend ACTUALLY points at, as far as this client
  // knows — advanced synchronously when a rebind succeeds, because the
  // reactive `scenario.environmentId` echo lags the mutation. Comparing
  // against the prop instead let an immediate "change it back" edit read as
  // a no-op and get silently swallowed while the backend stayed on the FIRST
  // target.
  const committedEnvironmentIdRef = useRef<string | null>(
    scenario.environmentId ?? null,
  );
  // Always the CURRENT reactive values, for the post-commit reconciliation
  // below: a subscription update that lands mid-commit is deliberately
  // skipped by both sync effects, and their deps have already settled by the
  // time the commit ends — clearing the guard alone never replays it. The
  // closure's own props are frozen at edit time, so it reads these instead.
  const latestEnvironmentIdRef = useRef<string | null>(
    scenario.environmentId ?? null,
  );
  latestEnvironmentIdRef.current = scenario.environmentId ?? null;
  const latestEnvironmentRowRef = useRef(environment);
  latestEnvironmentRowRef.current = environment;
  useEffect(() => {
    // Adopt remote rebinds (another member, or our own echo) — but never
    // mid-commit, when the ref is ahead of the subscription on purpose.
    if (committingRef.current) return;
    committedEnvironmentIdRef.current = scenario.environmentId ?? null;
  }, [scenario.environmentId]);
  useEffect(() => {
    if (!environment || committingRef.current) return;
    setComposer(composerStateFromEnvironments([environment]));
    // Keyed on identity + revision, not the (always-fresh) row object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environment?.environmentId, environment?.revision]);

  const composerActive = Boolean(scenario.environmentId && environment);
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
          await rebindEnvironmentScenario({
            scenarioId: scenario.scenarioId,
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
    scenario.description ?? "",
  );
  const descriptionFocusedRef = useRef(false);
  useEffect(() => {
    if (descriptionFocusedRef.current) return;
    setDescriptionDraft(scenario.description ?? "");
  }, [scenario.description]);

  const handleRename = async (name: string) => {
    try {
      await updateScenario({ scenarioId: scenario.scenarioId, name } as any);
    } catch (err) {
      toast.error(convexErrMessage(err, "Failed to rename the scenario"));
      // Rethrow so EditableTitle reverts to the persisted name.
      throw err;
    }
  };

  const persistDescription = async () => {
    descriptionFocusedRef.current = false;
    const next = descriptionDraft.trim();
    if (next === (scenario.description ?? "").trim()) {
      // No-op blur: resync the draft with the envelope, which also adopts any
      // remote value the focused-guard above deliberately skipped.
      setDescriptionDraft(scenario.description ?? "");
      return;
    }
    try {
      await updateScenario({
        scenarioId: scenario.scenarioId,
        description: next,
      } as any);
    } catch (err) {
      toast.error(convexErrMessage(err, "Failed to save the description"));
      setDescriptionDraft(scenario.description ?? "");
    }
  };

  // The URL is the stash for both the tab and the opened session: the gates
  // above remount this route during a cold boot, so state captured on first
  // mount wouldn't survive to the last one.
  const tab = parseUserTestingDetailTab(location.search);
  // Prefer hiding the header strip until Insights reports a filled cohort —
  // the empty panel already carries share, and a flash of both reads as a
  // duplicate. Sessions always shows the strip (see render below).
  //
  // The report is keyed by scenarioId so a scenario switch does not need a
  // separate reset effect (which can race the remounted workbench's report
  // in the same passive-effect flush and leave the strip stuck hidden).
  const [insightsEmptyReport, setInsightsEmptyReport] = useState<{
    scenarioId: string;
    empty: boolean;
  } | null>(null);
  const insightsEmpty =
    insightsEmptyReport?.scenarioId === scenario.scenarioId
      ? insightsEmptyReport.empty
      : true;
  // Stable ref: a new one each render loops InsightsWorkbench's report effect.
  const handleInsightsEmptyChange = useCallback(
    (empty: boolean) => {
      setInsightsEmptyReport((prev) =>
        prev?.scenarioId === scenario.scenarioId && prev.empty === empty
          ? prev
          : { scenarioId: scenario.scenarioId, empty },
      );
    },
    [scenario.scenarioId],
  );
  const searchParams = new URLSearchParams(location.search);
  const sessionParam = searchParams.get("session");
  const sessionDeepLinkThreadId = sessionParam;
  // Insights selection + which diagram it was made on, so a copied link
  // reopens exactly what the sender was looking at. The view is NORMALIZED
  // here rather than forwarded raw: an unrecognized value renders as flow
  // anyway, and passing it on would re-persist a typo into every subsequent
  // navigation instead of dropping it on the first one.
  const selParam = searchParams.get("sel");
  const view: InsightsView =
    searchParams.get("view") === "clusters" ? "clusters" : "flow";
  const urlSelection = useMemo(() => parseSelectionParam(selParam), [selParam]);

  // Present only when the environment can't resolve right now (archived, a
  // pinned plugin disabled, its host gone). The scenario still opens: its
  // sessions are history worth reading, and unpublishing it is the action
  // this state calls for.
  const environmentError = scenario.environmentError ?? null;

  const publishLink = scenario.link?.token
    ? buildScenarioLink(scenario.link.token, scenario.name)
    : null;

  // Legacy `?tab=edit|share|preview` → dedicated Edit route.
  useEffect(() => {
    if (editMode) return;
    if (!isLegacyUserTestingEditTab(location.search)) return;
    navigate(buildUserTestingScenarioEditPath(scenario.scenarioId), {
      replace: true,
    });
  }, [scenario.scenarioId, editMode, location.search, navigate]);

  // Preview remount key — follows environment rebinds while Edit is open.
  const previewEnvironmentKey = scenario.environmentId ?? "";

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
  const previewHostId = scenario.namedHostId ?? null;
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
      buildUserTestingScenarioPath(scenario.scenarioId, {
        tab: next,
        session: sessionParam ?? undefined,
        sel: selParam ?? undefined,
        view,
      }),
      { replace: true },
    );
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await deleteScenario({ scenarioId: scenario.scenarioId } as any);
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

  const headerTitle = (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
      <EditableTitle
        value={scenario.name}
        onSave={handleRename}
        variant="h1"
        placeholder="Scenario name"
        className="-ml-2 shrink-0 px-2 text-xl font-semibold tracking-tight"
        inputClassName="min-w-[8rem] max-w-full text-xl font-semibold tracking-tight"
      />
      {!editMode ? (
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
      ) : scenario.namedHostName ? (
        <span className="text-sm text-muted-foreground">
          Client: {scenario.namedHostName}
        </span>
      ) : null}
    </div>
  );

  if (editMode) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <DetailPageHeader
          backLabel={scenario.name || "Scenario"}
          onBack={() =>
            navigate(buildUserTestingScenarioPath(scenario.scenarioId))
          }
          backTestId="user-testing-detail-back"
          title={headerTitle}
          actions={
            publishLink && !environmentError ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-lg"
                asChild
              >
                <a
                  href={publishLink}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="user-testing-open-preview"
                >
                  <ExternalLink className="mr-1.5 size-3.5" />
                  Open preview
                </a>
              </Button>
            ) : null
          }
        />
        <div
          className="relative min-h-0 flex-1 overflow-hidden"
          data-testid="user-testing-edit-tab"
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
                        {environmentError.message} Its sessions are unaffected.
                      </p>
                    </div>
                  </div>
                ) : null}

                <ScenarioShareSection scenario={scenario} />

                {/* Keyed per scenario: the toggle holds optimistic state
                    across an await, and reusing one instance would let a
                    write started on one scenario resolve into another's. */}
                <ScenarioPerTurnFeedbackToggle
                  key={scenario.scenarioId}
                  scenario={scenario}
                />

                {/* Production scoring: grade sampled real sessions against
                    deterministic checks. Its own section — grading config is
                    a peer of sharing, not part of it. */}
                <ScenarioGradingSection scenario={scenario} />

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
                      Edit setup
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
                  <p className="text-sm font-medium text-foreground">Preview</p>
                </div>
                <div className="relative min-h-0 flex-1">
                  {isPreviewProfilePending ? (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                      Loading preview…
                    </div>
                  ) : (
                    <ScenarioPreviewPane
                      publishLink={environmentError ? null : publishLink}
                      mcpProfile={previewHost?.config.mcpProfile}
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

        <ScenarioDeleteConfirmDialog
          entityLabel="scenario"
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          scenarioName={scenario.name}
          isDeleting={isDeleting}
          onConfirm={handleDelete}
        />

        {environment ? (
          <NameEnvironmentDialog
            open={nameEnvironmentOpen}
            onOpenChange={setNameEnvironmentOpen}
            projectId={scenario.projectId}
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
                  projectId={scenario.projectId}
                  environments={liveNamedEnvironments}
                  value={composer}
                  onChange={handleComposerChange}
                  maxTargets={1}
                  disabled={isRebinding || !composerReady}
                  inModal
                  testIdPrefix="user-testing-detail"
                  environmentPickerFooter={
                    canPromoteEnvironment ? (
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

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <DetailPageHeader
        backLabel="User Testing"
        onBack={onBack}
        backTestId="user-testing-detail-back"
        title={headerTitle}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-lg"
              data-testid="user-testing-edit-button"
              onClick={() =>
                navigate(buildUserTestingScenarioEditPath(scenario.scenarioId))
              }
            >
              <Pencil className="mr-1.5 size-3.5" />
              Edit
            </Button>
            {publishLink && !environmentError ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-lg"
                asChild
              >
                <a
                  href={publishLink}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="user-testing-open-preview"
                >
                  <ExternalLink className="mr-1.5 size-3.5" />
                  Open preview
                </a>
              </Button>
            ) : null}
          </>
        }
        tabs={{
          value: tab,
          options: TAB_OPTIONS,
          onChange: goToTab,
          ariaLabel: "Scenario view",
          indicatorId: "user-testing-detail",
        }}
      >
        {tab === "insights" && insightsEmpty ? null : (
          <ScenarioShareBanner scenario={scenario} />
        )}
      </DetailPageHeader>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {tab === "sessions" ? (
          <div className="absolute inset-0">
            <ScenarioUsagePanel
              scenario={scenario}
              initialThreadId={sessionDeepLinkThreadId}
            />
          </div>
        ) : null}
        {tab === "insights" ? (
          <div className="absolute inset-0">
            {/* The workbench (empty state, Sankey, sessions) must stay up
                even when the window-insights rail is missing: those queries
                throw against an undeployed backend, and wrapping THIS whole
                tree in `fallback={null}` left a blank `absolute inset-0`.
                Isolate the rail; if the workbench itself blows up, show the
                share empty panel rather than nothing. */}
            <ErrorBoundary
              key={scenario.scenarioId}
              name="user-testing-insights"
              fallback={<ScenarioShareEmptyPanel scenario={scenario} />}
            >
              <InsightsWorkbench
                scope={{ kind: "scenario", scenarioId: scenario.scenarioId }}
                cohortKey={scenario.scenarioId}
                // Scenarios carry real-user traffic; the retired simulation
                // flow's rows are still in the database and stay hidden.
                augmentFilter={withHideSynthetic}
                urlSelection={urlSelection}
                onSelectionChange={(themes) => {
                  navigate(
                    buildUserTestingScenarioPath(scenario.scenarioId, {
                      tab: "insights",
                      session: sessionParam ?? undefined,
                      sel: themes ? serializeSelectionParam(themes) : undefined,
                      view,
                    }),
                    { replace: true },
                  );
                }}
                initialView={view}
                onViewChange={(nextView) => {
                  navigate(
                    buildUserTestingScenarioPath(scenario.scenarioId, {
                      tab: "insights",
                      session: sessionParam ?? undefined,
                      sel: selParam ?? undefined,
                      view: nextView,
                    }),
                    { replace: true },
                  );
                }}
                onOpenSession={(threadId) => {
                  navigate(
                    buildUserTestingScenarioPath(scenario.scenarioId, {
                      tab: "sessions",
                      session: threadId,
                      sel: selParam ?? undefined,
                      view,
                    }),
                    { replace: true },
                  );
                }}
                onOpenSessionsTab={() => {
                  navigate(
                    buildUserTestingScenarioPath(scenario.scenarioId, {
                      tab: "sessions",
                      session: sessionParam ?? undefined,
                      sel: selParam ?? undefined,
                      view,
                    }),
                    { replace: true },
                  );
                }}
                recommendationsSlot={
                  <ErrorBoundary
                    name="user-testing-insights-rail"
                    fallback={null}
                  >
                    {/* Repair tasks above the pattern rail: what to change,
                        then what concentrated. The subscription lives inside
                        this component (not in the page body) so a backend
                        without the query degrades to nothing instead of
                        taking the scenario page down, and it only mounts on
                        the insights tab — never in edit mode. Membership is
                        enforced at the backend; a non-member simply gets
                        nothing. */}
                    <ActionableFindings
                      boundaryName="user-testing-actionable-findings"
                      surface={{
                        kind: "scenario",
                        scenarioId: scenario.scenarioId,
                      }}
                      context={{ rerunLabel: "this user-testing scenario" }}
                      onOpenSession={(threadId) => {
                        navigate(
                          buildUserTestingScenarioPath(scenario.scenarioId, {
                            tab: "sessions",
                            session: threadId,
                            sel: selParam ?? undefined,
                            view,
                          }),
                          { replace: true },
                        );
                      }}
                    />
                    <RunInsightsProvider
                      surface={{
                        kind: "scenario",
                        scenarioId: scenario.scenarioId,
                      }}
                      onOpenSession={(threadId) => {
                        navigate(
                          buildUserTestingScenarioPath(scenario.scenarioId, {
                            tab: "sessions",
                            session: threadId,
                            sel: selParam ?? undefined,
                            view,
                          }),
                          { replace: true },
                        );
                      }}
                    >
                      <RunInsightsRecommendations />
                    </RunInsightsProvider>
                  </ErrorBoundary>
                }
                autoBackfillTopicMap
                emptyState={<ScenarioShareEmptyPanel scenario={scenario} />}
                onEmptyChange={handleInsightsEmptyChange}
                className="px-8 py-4"
                testIdPrefix="scenario-insights"
              />
            </ErrorBoundary>
          </div>
        ) : null}
      </div>

      <ScenarioDeleteConfirmDialog
        entityLabel="scenario"
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        scenarioName={scenario.name}
        isDeleting={isDeleting}
        onConfirm={handleDelete}
      />

      {environment ? (
        <NameEnvironmentDialog
          open={nameEnvironmentOpen}
          onOpenChange={setNameEnvironmentOpen}
          projectId={scenario.projectId}
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
                projectId={scenario.projectId}
                environments={liveNamedEnvironments}
                value={composer}
                onChange={handleComposerChange}
                maxTargets={1}
                disabled={isRebinding || !composerReady}
                inModal
                testIdPrefix="user-testing-detail"
                environmentPickerFooter={
                  canPromoteEnvironment ? (
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
