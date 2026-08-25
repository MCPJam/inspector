import { useEffect, useMemo, useState } from "react";
import { Link, Navigate } from "react-router";
import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  Layers,
  Loader2,
  Plus,
  Users,
} from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@mcpjam/design-system/button";
import { Badge } from "@mcpjam/design-system/badge";
import {
  buildProjectEnvironmentPath,
  buildUserTestingScenarioPath,
  routePaths,
  useAppNavigate,
} from "@/lib/app-navigation";
import {
  permalinkUnavailableMessage,
  resolvePermalinkTarget,
} from "@/lib/permalink-target";
import { isNamedEnvironment } from "@/lib/environment-label";
import { convexErrMessage } from "@/lib/convex-error";
import { useProjectEnvironmentsEnabledState } from "@/hooks/useProjectEnvironmentsEnabled";
import {
  useArchiveProjectEnvironment,
  useProjectEnvironments,
  useRestoreProjectEnvironment,
  type ProjectEnvironmentView,
} from "@/hooks/useProjectEnvironments";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ProjectEnvironmentEditor } from "./ProjectEnvironmentEditor";
import { EnvironmentCanvasPanel } from "./EnvironmentCanvasPanel";
import { useProjectEnvironmentConsumers } from "./use-project-environment-consumers";
import { useEnvironmentScenario } from "@/hooks/useScenarios";
import {
  takeEnvironmentDraftSeed,
  type EnvironmentDraftSeed,
} from "@/lib/environment-draft-seed";
import {
  clearTentativeCastle,
  listTentativeCastles,
  tentativeCastleToInitialDraft,
  type TentativeCastle,
} from "@/lib/tentative-castle-drafts";

/**
 * Full-page list⇄detail management screen for Project environments — named
 * host + server group + pinned-skills bundles that suites and journeys run
 * against. Flag-gated INSIDE the component so a direct `/environments` URL
 * cannot bypass the sidebar gate.
 */
export function ProjectEnvironmentsRoute({
  projectId,
  canManage,
  isAuthenticated,
  routeEnvironmentId = null,
}: {
  projectId: string | null;
  /** Admin-gated writes; members browse read-only. */
  canManage: boolean;
  /** Threaded to the detail canvas's host/server reads. */
  isAuthenticated: boolean;
  /**
   * The environment an `/environments/:environmentId` permalink named.
   *
   * Selection on this screen has always been component state, which is why
   * `/environments` alone could never be a permalink: it opens whichever row
   * the viewer last clicked. The param drives selection, and selection drives
   * the param back (see below), so the URL in the address bar is the URL an
   * agent would hand out for the same view.
   */
  routeEnvironmentId?: string | null;
}) {
  const flagEnabled = useProjectEnvironmentsEnabledState();

  // The management surface is the ONE place that sees every kind of row:
  // archived (to restore), and ad-hoc (to browse what has been run, and to
  // name one). Every other surface takes the named-only default.
  const environments = useProjectEnvironments(
    flagEnabled === true ? projectId : null,
    { includeArchived: true, includeAdhoc: true }
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // A just-created env, kept until the reactive list query includes it — so
  // we land on its detail immediately instead of bouncing back to the list.
  const [justCreated, setJustCreated] = useState<ProjectEnvironmentView | null>(
    null
  );
  // A Connect "Save as environment" seed, consumed one-shot below. Held in
  // state (not read inline) so the create form keeps it across re-renders, and
  // TAGGED with the project it was consumed for: `projectId` changes during
  // render while the seed is only replaced in an effect, so there is a commit in
  // which a stale seed would otherwise be rendered against the new project.
  const [seed, setSeed] = useState<{
    projectId: string;
    draft: EnvironmentDraftSeed;
  } | null>(null);
  /** Swarm composer tentative castle opened into create mode (not one-shot). */
  const [tentativeDraft, setTentativeDraft] = useState<{
    projectId: string;
    castle: TentativeCastle;
  } | null>(null);
  const [tentativeCastles, setTentativeCastles] = useState<TentativeCastle[]>(
    []
  );

  // The route is NOT keyed on projectId (router.tsx renders a bare
  // <EnvironmentsRoute />), so switching the active project re-runs this
  // component with a new `projectId` but every piece of selection state
  // intact. Reset all three:
  //   - `creating` is the harmful one — the editor would stay open holding the
  //     PREVIOUS project's host / server group / skill picks while bound to the
  //     new projectId. (The backend re-validates project scope, so a save
  //     fails rather than corrupting — but the form is broken and confusing.)
  //   - `selectedId` mostly self-heals once the new list arrives and no id
  //     matches, but clearing it avoids a flash of the wrong detail.
  //   - `justCreated` holds a raw env object from the OLD project that
  //     `selected` would otherwise return for up to 3s.
  //   - `seed` (below) carries a hostId captured in the previous project.
  useEffect(() => {
    setSelectedId(null);
    setCreating(false);
    setJustCreated(null);
    // A project switch also invalidates any seeded draft: the seed's hostId
    // belongs to the project it was captured in (same hazard as the editor's
    // own projectId reset).
    setSeed(null);
    setTentativeDraft(null);
  }, [projectId]);

  // Refresh tentative castle chips whenever the project (or create mode) changes.
  useEffect(() => {
    if (!projectId) {
      setTentativeCastles([]);
      return;
    }
    setTentativeCastles(listTentativeCastles(projectId));
  }, [projectId, creating]);

  // Consume the Connect handoff. Gated on the flag having SETTLED true: while
  // it hydrates this route renders null, and the seed waits in sessionStorage —
  // that is exactly why the handoff is storage-based, not in-memory. `take` is
  // read+delete, so a later manual /environments visit can't re-enter create
  // mode. Runs AFTER the projectId reset effect above (hook order), so the
  // reset can't clobber a same-render seed consumption.
  useEffect(() => {
    if (flagEnabled !== true || !projectId) return;
    const taken = takeEnvironmentDraftSeed(projectId);
    if (taken) {
      setSeed({ projectId: projectId.trim(), draft: taken });
      setTentativeDraft(null);
      setCreating(true);
    }
  }, [flagEnabled, projectId]);

  useEffect(() => {
    if (!justCreated) return;
    if (
      environments?.some((e) => e.environmentId === justCreated.environmentId)
    ) {
      setJustCreated(null);
      return;
    }
    const t = setTimeout(() => setJustCreated(null), 3000);
    return () => clearTimeout(t);
  }, [justCreated, environments]);

  const selected = useMemo(
    () =>
      environments?.find((e) => e.environmentId === selectedId) ??
      (justCreated?.environmentId === selectedId ? justCreated : null),
    [environments, selectedId, justCreated]
  );

  // ── Permalink round-trip ───────────────────────────────────────────
  //
  // Route → selection. Runs on every change of the param rather than once at
  // mount: the project switch above clears `selectedId`, and a deep-linked
  // arrival has to survive that.
  useEffect(() => {
    const wanted = routeEnvironmentId?.trim();
    if (!wanted || wanted === selectedId) return;
    setSelectedId(wanted);
    setCreating(false);
  }, [routeEnvironmentId, selectedId]);

  const routeState = resolvePermalinkTarget(
    routeEnvironmentId,
    environments,
    (environment) => environment.environmentId
  );

  // Selection → route, so the address bar always names what is on screen and
  // Back leaves the detail instead of leaving the surface. `replace` because
  // clicking through a list is not navigation history anyone wants to walk.
  const navigate = useAppNavigate();
  useEffect(() => {
    if (flagEnabled !== true) return;
    const current = routeEnvironmentId?.trim() ?? null;
    const shown = !creating && selected ? selected.environmentId : null;
    if (current === shown) return;
    // While the list is still loading, a permalink's id is not yet known to be
    // good or bad — rewriting the URL then would erase the target before it
    // could be honored.
    if (shown === null && routeState.kind === "loading") return;
    navigate(buildProjectEnvironmentPath(shown), { replace: true });
  }, [
    flagEnabled,
    creating,
    selected,
    routeEnvironmentId,
    routeState.kind,
    navigate,
  ]);

  // Only the seed/draft consumed FOR THE CURRENT project may reach the form.
  const activeSeed =
    seed && projectId && seed.projectId === projectId.trim()
      ? seed.draft
      : tentativeDraft &&
          projectId &&
          tentativeDraft.projectId === projectId.trim()
        ? tentativeCastleToInitialDraft(tentativeDraft.castle)
        : undefined;
  const activeTentativeId =
    tentativeDraft &&
    projectId &&
    tentativeDraft.projectId === projectId.trim()
      ? tentativeDraft.castle.id
      : null;

  // Only redirect on an explicit `false`. While PostHog hydrates the flag is
  // `undefined`; bouncing then would strand a flagged-in user who cold-loads
  // /environments directly. Render nothing until it settles.
  if (flagEnabled === false) {
    return <Navigate to={routePaths.servers} replace />;
  }
  if (flagEnabled === undefined) {
    return null;
  }

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a project to manage its environments.
      </div>
    );
  }

  // Detail mode is the ONE mode that escapes the centered `max-w-2xl` column:
  // it owns the full width so the read-only Connect canvas can sit beside the
  // editor. List and create modes keep the narrow shell verbatim.
  // A permalink to an environment this viewer cannot see says so, once, and
  // does NOT fall through to the list: rendering the collection instead is
  // exactly the silent wrong-resource landing permalinks exist to prevent.
  if (routeState.kind === "unavailable") {
    return (
      <div className="mx-auto flex h-full max-w-2xl flex-col justify-center gap-4 p-8">
        <p
          role="status"
          data-testid="environment-permalink-unavailable"
          className="text-sm text-muted-foreground"
        >
          {permalinkUnavailableMessage("environment")}
        </p>
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(routePaths.environments)}
          >
            Back to environments
          </Button>
        </div>
      </div>
    );
  }

  if (!creating && selected) {
    return (
      <EnvironmentDetail
        key={`${selected.environmentId}:${selected.archivedAt ?? "live"}`}
        projectId={projectId}
        environment={selected}
        canManage={canManage}
        isAuthenticated={isAuthenticated}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-8">
        {creating ? (
          <div className="space-y-4">
            <BackLink
              label="All environments"
              onClick={() => {
                setCreating(false);
                setSeed(null);
                setTentativeDraft(null);
              }}
            />
            <h1 className="text-lg font-semibold text-foreground">
              New environment
            </h1>
            <ProjectEnvironmentEditor
              // `initialDraft` feeds a useState initializer, so it is read once
              // per MOUNTED instance — the key is what makes a newly consumed
              // seed take effect. Keying on the seed's own project (not the
              // route's) is load-bearing: switching straight from a seeded form
              // in project A to a seeded form in B renders once with A's seed
              // still in state, so a `projectId`-based key would already have
              // claimed "seeded:B" for the stale draft and React would reuse
              // that instance — silently eating B's seed, which is already
              // deleted from storage. `activeSeed` also withholds the stale
              // draft from that intermediate commit entirely.
              key={
                activeTentativeId
                  ? `tentative:${activeTentativeId}`
                  : activeSeed && seed
                    ? `seeded:${seed.projectId}`
                    : "blank"
              }
              projectId={projectId}
              environment={null}
              canManage={canManage}
              initialDraft={activeSeed}
              onCreated={(env) => {
                if (activeTentativeId && projectId) {
                  clearTentativeCastle(projectId, activeTentativeId);
                }
                setCreating(false);
                setSeed(null);
                setTentativeDraft(null);
                setJustCreated(env);
                setSelectedId(env.environmentId);
              }}
              onCancelCreate={() => {
                setCreating(false);
                setSeed(null);
                setTentativeDraft(null);
              }}
            />
          </div>
        ) : (
          <EnvironmentList
            environments={environments}
            canManage={canManage}
            tentativeCastles={tentativeCastles}
            onSelect={setSelectedId}
            onNew={() => {
              setSeed(null);
              setTentativeDraft(null);
              setCreating(true);
            }}
            onOpenTentative={(castle) => {
              setSeed(null);
              setTentativeDraft({
                projectId: projectId.trim(),
                castle,
              });
              setCreating(true);
            }}
            onDiscardTentative={(castle) => {
              clearTentativeCastle(projectId, castle.id);
              setTentativeCastles(listTentativeCastles(projectId));
            }}
          />
        )}
      </div>
    </div>
  );
}

function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" /> {label}
    </button>
  );
}

function EnvironmentList({
  environments,
  canManage,
  tentativeCastles,
  onSelect,
  onNew,
  onOpenTentative,
  onDiscardTentative,
}: {
  environments: ProjectEnvironmentView[] | undefined;
  canManage: boolean;
  tentativeCastles: TentativeCastle[];
  onSelect: (id: string) => void;
  onNew: () => void;
  onOpenTentative: (castle: TentativeCastle) => void;
  onDiscardTentative: (castle: TentativeCastle) => void;
}) {
  if (environments === undefined) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> Loading environments…
      </div>
    );
  }
  // Three ways, not two. Ad-hoc rows get their own collapsed section so they
  // never compete with the environments a human curated, and ARCHIVED stays
  // named-only — an archived machine-minted row is noise nobody will restore.
  // NAMED rows only, in both sections. Ad-hoc rows are fetched (so a later
  // "From runs" section and the deep link can find them) but deliberately not
  // listed yet — they would otherwise land in the main list, which is exactly
  // the pollution this program removes. Archived stays named-only for good: an
  // archived machine-minted row is noise nobody will restore.
  const live = environments.filter(
    (e) => !e.archivedAt && isNamedEnvironment(e)
  );
  const archived = environments.filter(
    (e) => !!e.archivedAt && isNamedEnvironment(e)
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">
            Environments
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            A named bundle of one client, an optional server group, and optional
            pinned skills. Suites and journeys run against environments and
            resolve them at launch.
          </p>
        </div>
        {canManage ? (
          <Button size="sm" onClick={onNew}>
            <Plus className="mr-1.5 size-3.5" /> New environment
          </Button>
        ) : null}
      </div>

      {canManage && tentativeCastles.length > 0 ? (
        <div className="space-y-2" data-testid="environment-tentative-drafts">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
            Drafts
          </h2>
          <div className="flex flex-wrap gap-2">
            {tentativeCastles.map((castle) => (
              <div
                key={castle.id}
                className="flex items-center gap-1 rounded-full border border-dashed border-border/70 bg-muted/30 pl-1"
              >
                <button
                  type="button"
                  data-testid={`environment-tentative-draft-${castle.id}`}
                  className="rounded-full px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted/60"
                  onClick={() => onOpenTentative(castle)}
                >
                  {castle.name?.trim() || "Untitled draft"}
                  {castle.hostIds.length > 1
                    ? ` · ${castle.hostIds.length} clients`
                    : ""}
                </button>
                <button
                  type="button"
                  aria-label={`Discard ${castle.name?.trim() || "draft"}`}
                  className="rounded-full px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  onClick={() => onDiscardTentative(castle)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {live.length === 0 ? (
        <div className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          <Layers className="mx-auto mb-2 size-5" />
          No environments yet
          {canManage
            ? tentativeCastles.length > 0
              ? " — finish a draft above, or create one to get started."
              : " — create one to get started."
            : "."}
        </div>
      ) : (
        <div className="divide-y divide-border/60 rounded-md border">
          {live.map((env) => (
            <EnvironmentRow
              key={env.environmentId}
              env={env}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}

      {archived.length > 0 ? (
        <div className="space-y-2">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
            Archived
          </h2>
          <div className="divide-y divide-border/60 rounded-md border">
            {archived.map((env) => (
              <EnvironmentRow
                key={env.environmentId}
                env={env}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function EnvironmentRow({
  env,
  onSelect,
}: {
  env: ProjectEnvironmentView;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(env.environmentId)}
      className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm hover:bg-muted/50"
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-foreground">{env.name}</span>
        {env.description ? (
          <span className="truncate text-xs text-muted-foreground">
            {env.description}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {env.archivedAt ? <Badge variant="outline">Archived</Badge> : null}
        <span className="font-mono text-[10px] text-muted-foreground">
          rev {env.revision}
        </span>
      </span>
    </button>
  );
}

function EnvironmentDetail({
  projectId,
  environment,
  canManage,
  isAuthenticated,
  onBack,
}: {
  projectId: string;
  environment: ProjectEnvironmentView;
  canManage: boolean;
  isAuthenticated: boolean;
  onBack: () => void;
}) {
  const archiveEnvironment = useArchiveProjectEnvironment();
  const restoreEnvironment = useRestoreProjectEnvironment();
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [busy, setBusy] = useState(false);
  const { suiteCount, journeyCount, scenarioCount } =
    useProjectEnvironmentConsumers(
      projectId,
      confirmingArchive ? environment.environmentId : null
    );
  // Reads the shared scenario-list subscription, so this costs no extra query.
  const { scenario: publishedScenario } = useEnvironmentScenario({
    isAuthenticated,
    projectId,
    environmentId: environment.environmentId,
  });

  const isArchived = !!environment.archivedAt;

  // Advisory reference summary for the archive confirm. Both the eval-suite and
  // the journey scans are client-side and persona/visibility bound, so the copy
  // stays hedged ("may be incomplete"). Wait for BOTH to settle before
  // reporting, so a half-loaded state can't flash a misleading zero.
  const referenceSummary =
    suiteCount === null || journeyCount === null || scenarioCount === null
      ? "Checking references…"
      : (() => {
          const suitePart = `${suiteCount} suite${suiteCount === 1 ? "" : "s"}`;
          const journeyPart = `${journeyCount} journey${
            journeyCount === 1 ? "" : "s"
          }`;
          // The published scenario is called out separately: unlike suites and
          // journeys (which fail at their next launch), a scenario share link
          // is live for outsiders and starts failing the moment this archives.
          const scenarioPart =
            scenarioCount > 0
              ? " Its published tester link stops working immediately."
              : "";
          return suiteCount + journeyCount > 0
            ? `${suitePart} and ${journeyPart} reference it (count may be incomplete).${scenarioPart}`
            : `No referencing suites or journeys found (count may be incomplete).${scenarioPart}`;
        })();

  const onArchive = async () => {
    setBusy(true);
    try {
      // Archive is actioned on the row as currently shown (no draft), so the
      // reactive revision IS the base revision here.
      await archiveEnvironment({
        projectId,
        environmentId: environment.environmentId,
        expectedRevision: environment.revision,
      });
      toast.success(`Archived “${environment.name}”.`);
      setConfirmingArchive(false);
    } catch (err) {
      toast.error(convexErrMessage(err, "Could not archive the environment."));
    } finally {
      setBusy(false);
    }
  };

  const onRestore = async () => {
    setBusy(true);
    try {
      await restoreEnvironment({
        projectId,
        environmentId: environment.environmentId,
        expectedRevision: environment.revision,
      });
      toast.success(`Restored “${environment.name}”.`);
    } catch (err) {
      toast.error(convexErrMessage(err, "Could not restore the environment."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full min-h-0 overflow-hidden">
      <ResizablePanelGroup direction="horizontal" className="h-full">
        <ResizablePanel defaultSize={45} minSize={32}>
          {/* Editor column owns the scroll; the canvas column owns the height
              (ReactFlow measures its container, so it must not scroll). */}
          <div className="h-full overflow-y-auto px-6 py-8">
            <div className="mx-auto max-w-2xl space-y-4">
              <div className="flex items-center justify-between gap-3">
                <BackLink label="All environments" onClick={onBack} />
                <span className="flex items-center gap-2">
                  {isArchived ? (
                    <Badge variant="outline">Archived</Badge>
                  ) : null}
                  <span className="font-mono text-[10px] text-muted-foreground">
                    rev {environment.revision}
                  </span>
                </span>
              </div>

              {publishedScenario ? (
                // Absence renders nothing: an unpublished environment isn't in
                // a state worth naming. Publishing happens in User Testing —
                // this is only the pointer back to it, so someone editing an
                // environment can see it has real testers behind a live link.
                <Link
                  to={buildUserTestingScenarioPath(publishedScenario.scenarioId)}
                  data-testid="environment-published-scenario"
                  className="flex items-center gap-1.5 text-xs text-primary hover:underline"
                >
                  <Users className="size-3.5" />
                  Published as the User Testing scenario “
                  {publishedScenario.name}”
                </Link>
              ) : null}

              {isArchived ? (
                <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground">
                    Archived — hidden from pickers; suites and journeys still
                    referencing it fail fast at their next launch.
                  </p>
                  {canManage ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 shrink-0 text-xs"
                      disabled={busy}
                      onClick={() => void onRestore()}
                    >
                      <ArchiveRestore className="mr-1.5 size-3.5" /> Restore
                    </Button>
                  ) : null}
                </div>
              ) : null}

              <ProjectEnvironmentEditor
                projectId={projectId}
                environment={environment}
                canManage={canManage && !isArchived}
              />

              {canManage && !isArchived ? (
                <div className="flex items-center justify-between border-t pt-4">
                  {confirmingArchive ? (
                    <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>
                        Archive “{environment.name}”? {referenceSummary}{" "}
                        Referencing runs fail fast at their next launch.
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        className="h-7 text-xs"
                        disabled={busy}
                        onClick={() => void onArchive()}
                      >
                        {busy ? (
                          <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                        ) : null}
                        Archive
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        disabled={busy}
                        onClick={() => setConfirmingArchive(false)}
                      >
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setConfirmingArchive(true)}
                    >
                      <Archive className="mr-1.5 size-3.5" /> Archive
                    </Button>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={55} minSize={30}>
          <EnvironmentCanvasPanel
            projectId={projectId}
            environmentId={environment.environmentId}
            hostId={environment.hostId}
            revision={environment.revision}
            isArchived={isArchived}
            isAuthenticated={isAuthenticated}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
