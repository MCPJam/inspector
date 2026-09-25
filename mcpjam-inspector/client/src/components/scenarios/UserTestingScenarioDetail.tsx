import { SharedSettingsGate } from "@/components/billing/SharedSettingsGate";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import {
  AlertTriangle,
  ExternalLink,
  Eye,
  PenLine,
  Pencil,
  Trash2,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { DetailPageHeader } from "@/components/shared/detail-page-header";
import { ScenarioShareEmptyPanel } from "@/components/scenarios/ScenarioShareEmptyPanel";
import { ScenarioShareDialog } from "@/components/scenarios/ScenarioShareDialog";
import { ScenarioShareSection } from "@/components/scenarios/ScenarioShareSection";
import { ScenarioFindingsTab } from "@/components/scenarios/findings/scenario-findings-tab";
import { ScenarioPerTurnFeedbackToggle } from "@/components/scenarios/ScenarioPerTurnFeedbackToggle";
import { ScenarioTasksSection } from "@/components/scenarios/ScenarioTasksSection";
import { ScenarioUsagePanel } from "@/components/scenarios/ScenarioUsagePanel";
import { isStudyNameTakenError } from "@/components/scenarios/UserTestingScenarioCreateFlow";
import { InsightsWorkbench } from "@/components/shared/usage-insights/InsightsWorkbench";
import { withHideSynthetic } from "@/components/scenarios/user-testing-traffic";
import {
  parseSelectionParam,
  serializeSelectionParam,
} from "@/hooks/scenario-usage-filters";
import type { InsightsView } from "@/hooks/useInsightsFlowController";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { ScenarioDeleteConfirmDialog } from "@/components/scenarios/ScenarioDeleteConfirmDialog";
import { EditableTitle } from "@/components/evals/EditableTitle";
import { EnvironmentComposer } from "@/components/environment-composer/environment-composer";
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
import {
  useProjectEnvironment,
  useProjectEnvironments,
} from "@/hooks/useProjectEnvironments";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import { isAdhocEnvironment } from "@/lib/environment-label";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import {
  buildUserTestingScenarioEditPath,
  buildUserTestingScenarioPath,
  defaultUserTestingDetailTab,
  isLegacyUserTestingEditTab,
  parseUserTestingDetailTab,
  type UserTestingDetailTab,
  useAppNavigate,
} from "@/lib/app-navigation";
import {
  buildScenarioLink,
  withScenarioPreviewSurface,
} from "@/lib/scenario-session";
import { toast } from "@/lib/toast";

/**
 * One User Testing scenario.
 *
 * Detail (`/user-testing/:id`): Findings | Insights | Sessions under one
 * header carrying Edit / Open preview / Share. Edit (`/user-testing/:id/edit`)
 * holds Settings — name, description, environment, sharing permissions,
 * ratings — under a plain header: back to the study (named after it), the
 * word "Settings", and no action row. Those three buttons are how you LEAVE
 * the detail page for here or for a tester's view; repeating them on the page
 * they lead to was noise, and the back link naming the study while the title
 * named it again read as two of the same thing.
 *
 * Preview embeds the share link, so opening Edit starts a REAL guest session —
 * it shows up in Sessions. The embed tags itself `?surface=preview` so that
 * session is labelled.
 *
 * Insights are per-scenario — `ScenarioUsagePanel` is scenario-scoped. There is
 * deliberately no project-wide insights view: aggregating across scenarios that
 * point at different servers would produce themes nobody can act on.
 */
interface UserTestingScenarioDetailProps {
  scenario: ScenarioSettings;
  /**
   * Tester sessions recorded against this study, from the list row.
   *
   * `undefined` on a deployment that does not report the counter — which is
   * "unknown", not "none". The setup stays editable there: refusing every edit
   * on an unanswered question would take a working screen away from everyone
   * to protect a case we cannot see.
   */
  sessionCount?: number;
  /** `/user-testing/:id/edit` — the study's settings, no detail tabs. */
  editMode?: boolean;
  onBack: () => void;
  /** Parent returns to the list. */
  onDeleted: () => void;
}

const TAB_OPTIONS: ReadonlyArray<{
  value: UserTestingDetailTab;
  label: string;
}> = [
  { value: "findings", label: "Findings" },
  { value: "insights", label: "Insights" },
  { value: "sessions", label: "Sessions" },
];

/**
 * One settings card. Stacked in a single column, the edge is what keeps a run
 * of sections from reading as one undifferentiated form — it is the only thing
 * saying where "Sharing permissions" stops and "Ratings" starts.
 */
const SETTINGS_CARD =
  "space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm";
const SETTINGS_CARD_TITLE =
  "text-base font-medium tracking-tight text-foreground";

/**
 * The study's name as a Settings field, saved on blur or Enter.
 *
 * On Edit the header no longer carries the name — the back link already does,
 * and the two side by side read as a duplicate — so this is where it is
 * changed. A draft, reseeded from the stored name while the field is not
 * focused, so a collaborator's rename is picked up without clobbering typing.
 *
 * A taken name is said ON the field (the backend's `CONFLICT` on `name`, the
 * same refusal the create flow places), and the draft is kept so it can be
 * corrected. Any other failure toasts and reverts to what is stored.
 */
function StudyNameField({
  name,
  onSave,
}: {
  name: string;
  onSave: (name: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(name);
  const [taken, setTaken] = useState<string | null>(null);
  const focusedRef = useRef(false);
  // Set by Escape, read by the blur it triggers: discard rather than save.
  const discardRef = useRef(false);
  useEffect(() => {
    if (focusedRef.current) return;
    setDraft(name);
  }, [name]);

  const commit = async () => {
    focusedRef.current = false;
    const discard = discardRef.current;
    discardRef.current = false;
    const next = draft.trim();
    // Empty is not a name; unchanged is not a save.
    if (discard || !next || next === name.trim()) {
      setDraft(name);
      setTaken(null);
      return;
    }
    try {
      await onSave(next);
      setTaken(null);
    } catch (err) {
      if (isStudyNameTakenError(err)) {
        setTaken(next);
        return;
      }
      toast.error(getBillingErrorMessage(err, "Failed to rename the study"));
      setDraft(name);
    }
  };

  return (
    <div className="space-y-2">
      <Input
        aria-label="Study name"
        data-testid="user-testing-name"
        value={draft}
        maxLength={200}
        placeholder="Study name"
        aria-invalid={taken ? true : undefined}
        aria-describedby={taken ? "user-testing-name-taken" : undefined}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onChange={(e) => {
          setTaken(null);
          setDraft(e.target.value);
        }}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            discardRef.current = true;
            e.currentTarget.blur();
          }
        }}
      />
      {taken ? (
        <p
          id="user-testing-name-taken"
          className="text-xs text-destructive"
          role="alert"
          data-testid="user-testing-name-taken"
        >
          A study named &ldquo;{taken}&rdquo; already exists in this project.
          Give this one a different name.
        </p>
      ) : null}
    </div>
  );
}

export function UserTestingScenarioDetail({
  scenario,
  sessionCount,
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
  const [shareOpen, setShareOpen] = useState(false);

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

  /**
   * A study with results runs on a FIXED setup.
   *
   * Reported in review: nothing stopped someone from repointing a study at a
   * different client or server after testers had already been through it —
   * which leaves one set of sessions answered against Excalidraw and the next
   * against GitHub, under one name, with nothing on screen saying the ground
   * moved. Those results are no longer comparable, and no analysis over them
   * is honest.
   *
   * So the two pills that change where it runs lock once the first tester
   * session lands. Everything else about the study stays editable — the name,
   * the access, the tasks, the ratings — because none of that rewrites what
   * the existing sessions were an answer to.
   */
  const hasTesterSessions = (sessionCount ?? 0) > 0;
  // One sentence, the same on both pills: the fact IS the reason, and someone
  // who just pressed a control they cannot use wants to know why in the time
  // a toast is on screen.
  const SETUP_LOCKED = "This study already has sessions.";
  // The environment picker too, and not as belt-and-braces: picking a saved
  // environment RE-SEEDS the client and the server group, so locking those two
  // and leaving this one open locks nothing — the same change is one pill to
  // the left (caught in review).
  const setupLockedReason = hasTesterSessions
    ? {
        clients: SETUP_LOCKED,
        servers: SETUP_LOCKED,
        environments: SETUP_LOCKED,
      }
    : undefined;
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
            ? "This workspace's backend doesn't support editing a study's setup yet."
            : getBillingErrorMessage(
                err,
                "Could not update this study's setup",
              ),
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
  // What the draft was last seeded with. Holding focus is not evidence the
  // user changed anything, so this is what "dirty" is measured against —
  // otherwise a focused field with no edits saves its stale draft over a
  // value that arrived while the reseed below was suppressed.
  const descriptionSeedRef = useRef(scenario.description ?? "");
  // Which save owns the field. The seed is marked before a write lands, so a
  // later completion that is no longer the newest must not reconcile against
  // it — its value has already been superseded.
  const descriptionSaveRef = useRef(0);
  // Read by `adoptRemoteDescription`, which can run after an await: the render
  // it was defined in may already be stale, and rolling back to that render's
  // value would drop a collaborator's edit that landed mid-flight.
  const remoteDescriptionRef = useRef(scenario.description ?? "");
  remoteDescriptionRef.current = scenario.description ?? "";
  useEffect(() => {
    if (descriptionFocusedRef.current) return;
    descriptionSeedRef.current = scenario.description ?? "";
    setDescriptionDraft(scenario.description ?? "");
  }, [scenario.description]);

  const handleRename = async (name: string) => {
    try {
      await updateScenario({ scenarioId: scenario.scenarioId, name } as any);
    } catch (err) {
      toast.error(getBillingErrorMessage(err, "Failed to rename the study"));
      // Rethrow so EditableTitle reverts to the persisted name.
      throw err;
    }
  };

  const adoptRemoteDescription = () => {
    descriptionSeedRef.current = remoteDescriptionRef.current;
    setDescriptionDraft(remoteDescriptionRef.current);
  };

  const persistDescription = async () => {
    descriptionFocusedRef.current = false;
    const next = descriptionDraft.trim();
    // Nothing of the user's to save: the draft still holds what it was seeded
    // with, or it already matches what is stored. Resync either way, which
    // adopts a remote value the focused-guard above deliberately skipped.
    if (
      next === descriptionSeedRef.current.trim() ||
      next === (scenario.description ?? "").trim()
    ) {
      adoptRemoteDescription();
      return;
    }
    // Marked BEFORE the write, not after it: the seed is what "dirty" is
    // measured against, and leaving Edit re-measures while this is still in
    // flight. Advancing it late sent `next` a second time from that flush.
    const generation = ++descriptionSaveRef.current;
    descriptionSeedRef.current = next;
    try {
      await updateScenario({
        scenarioId: scenario.scenarioId,
        description: next,
      } as any);
    } catch (err) {
      // A newer save has taken over: its value is the one to keep, and
      // resyncing from here would drop it.
      if (generation !== descriptionSaveRef.current) return;
      toast.error(
        getBillingErrorMessage(err, "Failed to save the description"),
      );
      // Also rolls the marked seed back to what is actually stored.
      adoptRemoteDescription();
    }
  };

  // The field lives on Edit, and leaving Edit unmounts it without firing blur.
  // React drops the typed text, and `descriptionFocusedRef` stays true for the
  // life of this instance — which survives the flip — freezing the reseed
  // above. Clear the guard on the way out, and save only what the user really
  // changed: flushing a merely-focused draft would overwrite a value that
  // landed while the reseed was suppressed.
  useEffect(() => {
    if (editMode) return;
    descriptionFocusedRef.current = false;
    if (descriptionDraft === descriptionSeedRef.current) {
      adoptRemoteDescription();
      return;
    }
    void persistDescription();
    // Deliberately keyed on the Edit→detail flip alone: the draft and
    // `persistDescription` both change every render and would retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMode]);

  // The URL is the stash for both the tab and the opened session: the gates
  // above remount this route during a cold boot, so state captured on first
  // mount wouldn't survive to the last one.
  // The landing tab is a function of the study, not a constant: an empty study
  // opens on Insights, because Findings summarises tester sessions and renders
  // as an empty frame when there are none. See `defaultUserTestingDetailTab`.
  // Both reads below take it, and they must take the SAME one — the parser
  // falls back to it and the builder omits it, so they disagree at the cost of
  // a tab that cannot be clicked.
  const landingTab = defaultUserTestingDetailTab(sessionCount);
  const tab = parseUserTestingDetailTab(location.search, landingTab);
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

  // Settings no longer docks a live Preview beside itself (BB-176). The pane
  // embedded the share link, so merely OPENING Edit started a real guest
  // session that showed up in the study's own Sessions list — the creator's
  // editing was indistinguishable from tester traffic. "Open preview" in the
  // action row does the same job on demand, in a tab, and says so.

  const goToTab = (next: UserTestingDetailTab) => {
    // Replace, not push: flipping a sub-tab shouldn't put a stop on the back
    // button between the scenario and the list. `session` and `sel` are
    // PRESERVED: both name something the user picked, and dropping them on a
    // tab flip loses the selection they came back to the other tab to see —
    // and makes the URL they copied stop describing what is on screen.
    navigate(
      buildUserTestingScenarioPath(scenario.scenarioId, {
        tab: next,
        defaultTab: landingTab,
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
      toast.success("Study deleted");
      setDeleteOpen(false);
      onDeleted();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to delete the study",
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
        placeholder="Study name"
        // `shrink` overrides the design-system button's own shrink-0, which
        // otherwise keeps the name at full width and pushes the tabs off.
        className="-ml-2 min-w-0 shrink px-2 text-xl font-semibold tracking-tight"
        inputClassName="min-w-[8rem] max-w-full text-xl font-semibold tracking-tight"
      />
    </div>
  );

  // Edit's title is the PAGE, not the study: the back link beside it already
  // names the study, and the name is edited in its own card below.
  const editHeaderTitle = (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
      <h1 className="text-xl font-semibold tracking-tight text-foreground">
        Settings
      </h1>
      {/* Host-backed scenarios get no Environment section — nothing else on
          Edit names the client they run against, so the header does. */}
      {!composerActive && scenario.namedHostName ? (
        <span
          className="shrink-0 text-sm text-muted-foreground"
          data-testid="user-testing-host-client"
        >
          Client: {scenario.namedHostName}
        </span>
      ) : null}
    </div>
  );

  // The detail tabs' action row: Edit, Open preview, and the single primary
  // Share. Not shown on Edit — all three lead AWAY from the detail page, to
  // Settings or to a tester's view, and Settings is where they lead. Sharing
  // there lives in its own Sharing permissions card.
  const headerActions = (
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
            // TAGGED as preview traffic. A creator opening their own study
            // starts a real guest session, so an untagged link puts their
            // look-around in the study's own Sessions list as if a tester had
            // run it. The docked pane used to set this on its iframe; with the
            // pane gone this is the only preview path, so it carries it here.
            href={withScenarioPreviewSurface(publishLink)}
            target="_blank"
            rel="noreferrer"
            data-testid="user-testing-open-preview"
            /* Says WHAT opens, because research read this button as a second
               step of setting the study up rather than as the tester's own
               session (BB-176). The visible label stays short; the hover and
               accessible name carry the rest. */
            title="Opens this study exactly as a tester sees it, in a new tab"
            aria-label="Open preview: this study as a tester sees it"
          >
            <Eye className="mr-1.5 size-3.5" />
            Open preview
          </a>
        </Button>
      ) : null}
      <Button
        type="button"
        size="sm"
        className="rounded-lg"
        data-testid="user-testing-share-button"
        onClick={() => setShareOpen(true)}
      >
        <ExternalLink className="mr-1.5 size-3.5" />
        Share
      </Button>
    </>
  );

  if (editMode) {
    return (
      <SharedSettingsGate
        projectId={scenario.projectId}
        creatorId={scenario.owner?.userId}
        resource="user-testing study"
      >
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          {/* Back goes to the scenario, not the list: Edit is a sub-route of
            it, and the list would leave no one-click way back. */}
          <DetailPageHeader
            backLabel={scenario.name || "Study"}
            onBack={() =>
              navigate(buildUserTestingScenarioPath(scenario.scenarioId))
            }
            backTestId="user-testing-detail-back"
            title={editHeaderTitle}
          />
          <div
            className="relative min-h-0 flex-1 overflow-hidden"
            data-testid="user-testing-edit-tab"
          >
            {/* ONE COLUMN of wide cards, centred.

              This was two columns from `xl`, which answered an older report
              ("too much white space") by filling the pane. Settings reads top
              to bottom now, the way every other settings surface in the app
              does: two columns made the reading order ambiguous — a second
              column starting level with the first gives no answer to "what do
              I look at after Description", and on a study whose sections
              differ in height it left one side ragged.

              The cards stay WIDE (this cap, not a reading measure): the
              complaint the two-column layout was built for is real, and a
              single column at 560px would bring it straight back.

              Section ORDER is the old column order read down — the study
              itself (what it says, where it runs, what it asks people to try),
              then the rules it runs under (who may open it, what gets rated,
              what gets graded). That is already what every screen below `xl`
              has been showing, so nothing moves for anyone on a laptop.

              Cards, not bare headings: a run of sections with no boundary
              reads as one long form that happens to have gaps. */}
            <div className="h-full overflow-y-auto px-6 py-6 sm:px-8">
              <div className="mx-auto w-full max-w-[960px] space-y-6">
                <div className="space-y-6">
                  <div className="min-w-0 space-y-6">
                    <section
                      className={SETTINGS_CARD}
                      data-testid="user-testing-name-section"
                    >
                      <h2 className={SETTINGS_CARD_TITLE}>Study name</h2>
                      <StudyNameField
                        name={scenario.name}
                        onSave={async (name) => {
                          await updateScenario({
                            scenarioId: scenario.scenarioId,
                            name,
                          } as any);
                        }}
                      />
                    </section>

                    {/* Off the header row as of BB-202: a field that grows next to
                  the title crowds the tabs. Still the only editor for it. */}
                    <section
                      className={SETTINGS_CARD}
                      data-testid="user-testing-description-section"
                    >
                      <div className="space-y-1">
                        <h2 className={SETTINGS_CARD_TITLE}>Description</h2>
                        <p className="text-xs text-muted-foreground">
                          For you and your project. Testers don&apos;t see it.
                        </p>
                      </div>
                      <TextareaAutosize
                        aria-label="Study description"
                        data-testid="user-testing-description"
                        value={descriptionDraft}
                        onChange={(e) => setDescriptionDraft(e.target.value)}
                        onFocus={() => {
                          descriptionFocusedRef.current = true;
                        }}
                        onBlur={() => void persistDescription()}
                        minRows={2}
                        maxRows={8}
                        maxLength={2000}
                        placeholder="Add a description…"
                        className="resize-none text-sm"
                      />
                    </section>

                    {environmentError ? (
                      <div
                        data-testid="user-testing-detail-environment-error"
                        className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3"
                      >
                        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500" />
                        <div className="min-w-0 text-sm">
                          <p className="font-medium text-foreground">
                            {environmentError.code === "ENV_ARCHIVED"
                              ? "This study's environment is archived, so the share link no longer opens."
                              : "This study's environment can't be loaded right now, so the share link won't open."}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {environmentError.message} Its sessions are
                            unaffected.
                          </p>
                        </div>
                      </div>
                    ) : null}

                    {/* Where this scenario runs, edited in place. It used to hide
                    behind a footer "Edit setup" dialog; the setup IS the
                    setting, so it reads as one here. */}
                    {composerActive ? (
                      <section
                        className={SETTINGS_CARD}
                        data-testid="user-testing-environment-section"
                      >
                        <h2 className={SETTINGS_CARD_TITLE}>Environment</h2>
                        <div className="min-w-0">
                          <EnvironmentComposer
                            projectId={scenario.projectId}
                            environments={liveNamedEnvironments}
                            value={composer}
                            onChange={handleComposerChange}
                            maxTargets={1}
                            disabled={isRebinding || !composerReady}
                            lockedSlots={setupLockedReason}
                            testIdPrefix="user-testing-detail"
                            environmentPickerFooter={
                              canPromoteEnvironment ? (
                                // The row behind this setup is ad-hoc:
                                // content-addressed, immutable, labeled by its
                                // client rather than a name. Saving it (in place,
                                // same id) turns it into a curated environment
                                // other surfaces can pick.
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
                      </section>
                    ) : null}

                    {/* The same "what to try" list create step 2 authors, keyed
                    per scenario for the reason the ratings toggle is: this
                    section holds an unsaved draft, and reusing one instance
                    across scenarios would carry one study's rows into
                    another's editor. */}
                    <div className={SETTINGS_CARD}>
                      <ScenarioTasksSection
                        key={scenario.scenarioId}
                        scenario={scenario}
                      />
                    </div>
                  </div>

                  {/* The rules it runs under. Its own wrapper, not merged into
                    the one above: the grouping is still real, it is just read
                    in sequence now rather than side by side. */}
                  <div className="min-w-0 space-y-6">
                    <section className={SETTINGS_CARD}>
                      <h2 className={SETTINGS_CARD_TITLE}>
                        Sharing permissions
                      </h2>
                      <ScenarioShareSection scenario={scenario} />
                    </section>

                    <section className={SETTINGS_CARD}>
                      <h2 className={SETTINGS_CARD_TITLE}>Ratings</h2>
                      {/* Keyed per scenario: the toggle holds optimistic state
                        across an await, and reusing one instance would let a
                        write started on one scenario resolve into another's. */}
                      <ScenarioPerTurnFeedbackToggle
                        key={scenario.scenarioId}
                        scenario={scenario}
                      />
                    </section>
                  </div>
                </div>

                {/* Last, and visibly apart from the cards above it: the one
                  control here that cannot be undone should not sit in a run of
                  sections where a mis-aimed click lives next to a switch. */}
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/25 bg-destructive/5 px-5 py-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      Delete this study
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Removes the study, its share link and its sessions. This
                      cannot be undone.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-lg text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setDeleteOpen(true)}
                    data-testid="user-testing-delete"
                  >
                    <Trash2 className="mr-1.5 size-4" />
                    Delete study
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <ScenarioDeleteConfirmDialog
            entityLabel="study"
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
        </div>
      </SharedSettingsGate>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <DetailPageHeader
        backLabel="User Testing"
        onBack={onBack}
        backTestId="user-testing-detail-back"
        title={headerTitle}
        actions={headerActions}
        tabs={{
          value: tab,
          options: TAB_OPTIONS,
          onChange: goToTab,
          ariaLabel: "Study view",
          indicatorId: "user-testing-detail",
        }}
      />

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {tab === "findings" ? (
          <div className="absolute inset-0 overflow-y-auto px-8 py-4">
            {/* Same guard, same reason, as Insights below — and it matters
                MORE here. That boundary was added when Insights was a tab a
                reader opted into; Findings is the landing tab, so a throw
                from its drill-down query blanks the default view of
                `/user-testing/:scenarioId` for everyone arriving without a
                `?tab=`. `ScenarioGoalChain` already guards the secondary
                query on this surface, which left the primary one as the only
                unguarded `useQuery` on the page. */}
            <ErrorBoundary
              key={scenario.scenarioId}
              name="user-testing-findings"
              fallback={<ScenarioShareEmptyPanel scenario={scenario} />}
            >
              <ScenarioFindingsTab
                scenarioId={scenario.scenarioId}
                // Insights' empty panel, so an unrun study reads the same on
                // either tab instead of Findings being a blank frame.
                emptyState={
                  <ScenarioShareEmptyPanel
                    scenario={scenario}
                    surface="findings"
                  />
                }
                onOpenSession={(threadId) =>
                  navigate(
                    buildUserTestingScenarioPath(scenario.scenarioId, {
                      tab: "sessions",
                      session: threadId,
                      sel: selParam ?? undefined,
                      view,
                    }),
                    { replace: true },
                  )
                }
              />
            </ErrorBoundary>
          </div>
        ) : null}
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
            {/* Insights is the Sankey and the clusters, nothing else (BB-230).
                The recommendations rail that used to sit above them is gone;
                "read a finding, then open the session it is about" now lives
                on Findings, via the stage -> sessions link.

                Keep this boundary: `fallback={null}` here would leave a blank
                `absolute inset-0`, so if the workbench blows up, show the
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
                emptyState={<ScenarioShareEmptyPanel scenario={scenario} />}
                className="px-8 py-4"
                testIdPrefix="scenario-insights"
              />
            </ErrorBoundary>
          </div>
        ) : null}
      </div>

      <ScenarioShareDialog
        scenario={scenario}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />

      <ScenarioDeleteConfirmDialog
        entityLabel="study"
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
    </div>
  );
}
