/**
 * The suite's "where this runs" bar.
 *
 * Lives on the suite settings sheet (not the overview header): clients,
 * models, servers, skills, and named environments are configuration, not
 * a run-time switch. One strip, two write modes, because a suite can
 * express its target two ways:
 *
 *  - ENVIRONMENT mode (`suite.environmentIds`) — the modern one. Run all fans
 *    out one run per environment and the backend resolves each at launch. Every
 *    slot is live here, and an edit resolves the composition into rows before
 *    writing `setSuiteEnvironments`.
 *  - LEGACY mode (`hostAttachments` + `serverAttachmentId`) — the only option
 *    for a suite with no project, since environments are project-scoped. Two
 *    slots, writing the fields they have always written.
 *
 * A legacy suite in an environment-capable project shows the full strip seeded
 * from what it already runs, and the FIRST edit converts it. That conversion is
 * the point: `buildSuiteRunPlans` already lets `environmentIds` silently win
 * over the legacy axes, so a header that keeps offering both is a header where
 * half the controls do nothing. Here the mode decides which controls exist.
 *
 * Seeding never writes — only user edits do.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { Globe, Server } from "lucide-react";
import { ClientsPill } from "@/components/environment-composer/clients-pill";
import {
  EnvironmentComposer,
  EVALS_COMPOSER_SLOTS,
} from "@/components/environment-composer/environment-composer";
import { SandboxImagePill } from "@/components/environment-composer/sandbox-image-pill";
import {
  composerHasTarget,
  composerStateFromEnvironments,
  environmentsCarryModels,
  environmentsCarryPluginPins,
  environmentsExceedOneStack,
  type EnvironmentComposerState,
} from "@/components/environment-composer/environment-stack";
import { useComposerResolver } from "@/components/environment-composer/use-composer-resolver";
import { ServerPicker } from "@/components/hosts/server-picker";
import { MAX_SUITE_ENVIRONMENTS } from "@/components/project-environments/environment-picker";
import { useComputersEnabled } from "@/hooks/useComputersEnabled";
import {
  useModelMatrixCapability,
  useProjectEnvironments,
} from "@/hooks/useProjectEnvironments";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import { useSkillsEnabled } from "@/hooks/useSkillsEnabled";
import { convexErrMessage } from "@/lib/convex-error";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { HostAttachmentDraft } from "./client-attachments-editor";
import type { EvalSuite } from "./types";

export interface SuiteEnvironmentComposerBarProps {
  suite: EvalSuite;
  readOnly?: boolean;
  /** Legacy-mode client write. Absent ⇒ the whole bar is read-only. */
  onUpdate?: (attachments: HostAttachmentDraft[]) => Promise<void>;
  /** Legacy-mode server-group write. */
  onUpdateServerAttachment?: (serverAttachmentId: string) => Promise<void>;
  className?: string;
  /** `panel` = card surface. `inline` = no chrome, for a tight row. */
  containerVariant?: "panel" | "inline";
  /**
   * Hide the computer/sandbox pill when the settings sheet already has
   * its own Computer environment row, so the two don't sit on the same
   * page offering the same pin.
   */
  omitComputers?: boolean;
}

export function SuiteEnvironmentComposerBar({
  suite,
  readOnly = false,
  onUpdate,
  onUpdateServerAttachment,
  className,
  containerVariant = "panel",
  omitComputers = false,
}: SuiteEnvironmentComposerBarProps) {
  const projectId = suite.projectId ?? null;
  const environmentsEnabled = useProjectEnvironmentsEnabled();
  // Environments are project-scoped, so a suite without a project can only ever
  // run the legacy axes — no flag makes that untrue.
  const envCapable = Boolean(projectId) && environmentsEnabled;

  /**
   * A suite that already ATTACHES environments is never legacy-editable, even
   * when this deployment can't offer the composer (project environments off).
   * `buildSuiteRunPlans` prefers `environmentIds`, so writing `hostAttachments`
   * would report success and change nothing about what runs — the exact trap
   * this bar exists to remove. Show the legacy axes read-only instead.
   */
  const attachesEnvironments = (suite.environmentIds?.length ?? 0) > 0;
  const editable =
    !readOnly && Boolean(onUpdate) && !(attachesEnvironments && !envCapable);

  return envCapable && projectId ? (
    <BarShell className={className} containerVariant={containerVariant}>
      <EnvironmentModeBar
        suite={suite}
        projectId={projectId}
        disabled={!editable}
        omitComputers={omitComputers}
      />
    </BarShell>
  ) : (
    <BarShell className={className} containerVariant={containerVariant}>
      <LegacyModeBar
        suite={suite}
        editable={editable}
        onUpdate={onUpdate}
        onUpdateServerAttachment={onUpdateServerAttachment}
        omitComputers={omitComputers}
      />
    </BarShell>
  );
}

function BarShell({
  children,
  className,
  containerVariant,
}: {
  children: React.ReactNode;
  className?: string;
  containerVariant: "panel" | "inline";
}) {
  return (
    <div
      className={cn(
        containerVariant === "panel"
          ? "rounded-lg bg-card py-2.5 text-card-foreground"
          : "bg-transparent py-0 text-card-foreground",
        className
      )}
      data-testid="suite-environment-bar"
    >
      <div
        className={cn(
          "flex min-h-9 items-center gap-x-2 px-1 sm:px-2",
          containerVariant === "inline"
            ? "w-max min-w-0 max-w-full flex-nowrap"
            : "flex-wrap gap-y-2"
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** Environment mode: the full strip, committing through `setSuiteEnvironments`. */
function EnvironmentModeBar({
  suite,
  projectId,
  disabled,
  omitComputers,
}: {
  suite: EvalSuite;
  projectId: string;
  disabled: boolean;
  omitComputers: boolean;
}) {
  // Ad-hoc rows included: once the composer has been used, the suite's own
  // attachments ARE ad-hoc, and seeding has to see them.
  const environments = useProjectEnvironments(projectId, {
    includeAdhoc: true,
  });
  const resolveTargets = useComposerResolver(projectId);
  const setSuiteEnvironments = useMutation(
    "testSuites:setSuiteEnvironments" as any
  ) as unknown as (args: {
    suiteId: string;
    environmentIds: string[] | null;
  }) => Promise<unknown>;

  const attachedIds = useMemo(
    () => suite.environmentIds ?? [],
    [suite.environmentIds]
  );
  const liveEnvironments = useMemo(
    () => (environments ?? []).filter((e) => !e.archivedAt),
    [environments]
  );
  const attachedEnvironments = useMemo(
    () =>
      attachedIds
        .map((id) => liveEnvironments.find((e) => e.environmentId === id))
        .filter((e): e is NonNullable<typeof e> => Boolean(e)),
    [attachedIds, liveEnvironments]
  );
  /** `undefined` until the query settles. `[]` would read as "none exist". */
  const environmentsLoading = environments === undefined;
  /**
   * An attachment that no live row resolves — archived, or deleted out from
   * under the suite. Every edit here rewrites `environmentIds` wholesale, so
   * proceeding would either silently drop it or be rejected by the backend's
   * liveness check. Neither is a thing to do behind the user's back.
   *
   * Gated on the query having SETTLED: while loading, every attachment looks
   * unresolved, which would flash the warning and disable the strip on any
   * environment suite.
   */
  const unresolvedCount = environmentsLoading
    ? 0
    : attachedIds.length - attachedEnvironments.length;
  const skillsEnabled = useSkillsEnabled();
  const computersEnabled = useComputersEnabled();
  const modelMatrix = useModelMatrixCapability(projectId);
  const modelsEnabled = modelMatrix === true;
  const seeded = useMemo<EnvironmentComposerState>(() => {
    if (attachedIds.length > 0) {
      return composerStateFromEnvironments(attachedEnvironments, {
        skillsEnabled,
        computersEnabled,
        modelsEnabled,
      });
    }
    // Not an environment suite yet: show what it runs today, so converting
    // preserves it rather than starting from blank.
    return {
      environmentIds: [],
      stack: {
        hostIds: (suite.hostAttachments ?? []).map((a) => a.namedHostId),
        serverAttachmentId: suite.serverAttachmentId ?? null,
        skillSelection: null,
        computerEnvironmentId:
          suite.environment?.computerEnvironmentId ?? null,
        modelSelection: { includeClientDefaults: true, explicitModelIds: [] },
      },
      customized: false,
    };
  }, [
    attachedEnvironments,
    attachedIds.length,
    computersEnabled,
    modelsEnabled,
    skillsEnabled,
    suite.environment?.computerEnvironmentId,
    suite.hostAttachments,
    suite.serverAttachmentId,
  ]);
  /**
   * The ATTACHMENTS cannot be represented as one stack — two on a single client,
   * disagreeing on an enabled shared slot, or (for a seed the composer treats as
   * a pure composition) carrying plugin pins — so editing any pill would change
   * what some of them run.
   *
   * The composer has its own guard for the same shapes, but only for a live
   * NAMED selection. This one is computed from the PERSISTED attachments, which
   * is the case it cannot see: ad-hoc or mixed rows seed as a composition
   * (`customized: true`), where the composer has no saved selection left to
   * protect. Pins on an all-named attachment are deliberately NOT handled here —
   * the composer's guard catches those while keeping the selection picker
   * usable, which is the way out.
   */
  const collapsesByHost =
    environmentsExceedOneStack(attachedEnvironments, {
      skillsEnabled,
      computersEnabled,
      modelsEnabled,
    }) ||
    (seeded.customized && environmentsCarryPluginPins(attachedEnvironments)) ||
    // A model override with no slot to show it in. `environmentsExceedOneStack`
    // only catches a DISAGREEMENT between attachments, so a suite whose
    // attachments all pin the SAME model slips past it — and seeding then reads
    // the slot as "client defaults", so the first pill edit resolves rows
    // without the override and silently moves the suite to another model.
    (!modelsEnabled && environmentsCarryModels(attachedEnvironments));
  /**
   * The capability probe has not answered yet. Distinct from `collapsesByHost`:
   * nothing is wrong with the attachments, we just cannot yet tell whether the
   * models slot exists — and until we can, `modelsEnabled` reads false, which
   * is the same input that makes a model-bearing attachment look uneditable.
   * Disabling (rather than declaring a collapse) keeps the hint from flashing
   * on every load, matching how the environment list is handled above.
   */
  const modelCapabilityPending = Boolean(projectId) && modelMatrix === undefined;

  const [state, setState] = useState<EnvironmentComposerState>(seeded);
  const [saving, setSaving] = useState(false);
  // Re-seed when the suite's own data changes (another tab, the settings sheet,
  // or our own write landing) — keyed on content so a new array identity from
  // the live query doesn't stomp what the user is mid-way through.
  const seedKey = JSON.stringify(seeded);
  useEffect(() => {
    setState(JSON.parse(seedKey) as EnvironmentComposerState);
  }, [seedKey]);

  // Version counter: a stale failure must not roll back state a newer
  // successful commit already wrote.
  const commitVersion = useRef(0);
  const commit = useCallback(
    async (next: EnvironmentComposerState) => {
      const previous = state;
      const mine = ++commitVersion.current;
      setState(next);
      setSaving(true);
      try {
        // Detaching EVERYTHING is a legitimate move — it returns the suite to
        // its legacy axes — so it clears the field instead of being resolved.
        // Resolution would refuse it (a composition needs a target), and the
        // user would get an error for unchecking the last box.
        const emptied = !composerHasTarget(next);
        // Resolve BEFORE writing: a failure mid-way leaves at most some
        // deduped ad-hoc rows nothing points at, never a half-updated suite.
        const environmentIds = emptied
          ? null
          : (
              await resolveTargets({
                state: next,
                liveEnvironments,
                max: MAX_SUITE_ENVIRONMENTS,
              })
            ).environmentIds;
        await setSuiteEnvironments({
          suiteId: suite._id,
          // The backend rejects an empty array; `null` is how a field clears.
          environmentIds:
            environmentIds && environmentIds.length > 0 ? environmentIds : null,
        });
      } catch (err) {
        if (commitVersion.current === mine) setState(previous);
        // Verbatim: this is where a schedule-pin conflict names the schedule
        // blocking the change, and a resolve failure explains itself.
        toast.error(convexErrMessage(err, "Failed to update where this runs"));
      } finally {
        if (commitVersion.current === mine) setSaving(false);
      }
    },
    [
      liveEnvironments,
      resolveTargets,
      setSuiteEnvironments,
      state,
      suite._id,
    ]
  );

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <EnvironmentComposer
          projectId={projectId}
          environments={liveEnvironments}
          value={state}
          onChange={(next) => void commit(next)}
          maxTargets={MAX_SUITE_ENVIRONMENTS}
          // `onUpdateServerAttachment` takes an id, not `id | null`, so there
          // is nothing to commit a clear to — and the create form gates submit
          // on the same field.
          serverOptional={false}
          slots={
            omitComputers
              ? EVALS_COMPOSER_SLOTS.filter((slot) => slot !== "computers")
              : EVALS_COMPOSER_SLOTS
          }
          // Also disabled while the environment list is still loading: resolving
          // against an empty live list would miss a matching NAMED environment
          // and mint an unnamed twin of it.
          disabled={
            disabled ||
            saving ||
            environmentsLoading ||
            modelCapabilityPending ||
            unresolvedCount > 0 ||
            collapsesByHost
          }
          testIdPrefix="suite-env"
        />
      </div>
      {unresolvedCount > 0 ? (
        <p
          className="text-[11px] text-muted-foreground"
          data-testid="suite-env-unresolved-hint"
        >
          {unresolvedCount === 1
            ? "One attached environment is archived or unavailable."
            : `${unresolvedCount} attached environments are archived or unavailable.`}{" "}
          Detach it from the Environments pill before changing other slots.
        </p>
      ) : collapsesByHost ? (
        <p
          className="text-[11px] text-muted-foreground"
          data-testid="suite-env-attachments-collapse-hint"
        >
          This suite&apos;s environments don&apos;t fit one editable setup —
          they differ by client, server group, skills, model or image, or pin
          plugin versions — so this strip can&apos;t change them without changing
          what some of them run. Edit them individually on the Environments
          page.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Legacy mode: the two axes a pre-environments suite actually runs, using the
 * same shared pills so there is one clients control in the product, not two.
 */
function LegacyModeBar({
  suite,
  editable,
  onUpdate,
  onUpdateServerAttachment,
  omitComputers,
}: {
  suite: EvalSuite;
  editable: boolean;
  onUpdate?: (attachments: HostAttachmentDraft[]) => Promise<void>;
  onUpdateServerAttachment?: (serverAttachmentId: string) => Promise<void>;
  omitComputers: boolean;
}) {
  const initialAttachments = useMemo<HostAttachmentDraft[]>(
    () =>
      (suite.hostAttachments ?? []).map((attachment) => ({
        namedHostId: attachment.namedHostId,
        enabledOptionalServerIds: attachment.enabledOptionalServerIds,
      })),
    [suite.hostAttachments]
  );
  const [attachments, setAttachments] =
    useState<HostAttachmentDraft[]>(initialAttachments);
  useEffect(() => {
    setAttachments(initialAttachments);
  }, [initialAttachments]);
  const updateSuite = useMutation(
    "testSuites:updateTestSuite" as any
  ) as unknown as (args: Record<string, unknown>) => Promise<unknown>;

  const persistVersion = useRef(0);
  const persist = useCallback(
    async (next: HostAttachmentDraft[]) => {
      if (!onUpdate) return;
      const previous = attachments;
      const mine = ++persistVersion.current;
      setAttachments(next);
      try {
        await onUpdate(next);
      } catch (error) {
        if (persistVersion.current === mine) setAttachments(previous);
        console.error("Failed to update suite host attachments", error);
      }
    },
    [attachments, onUpdate]
  );

  /**
   * The sandbox image belongs on this bar even in legacy mode — a legacy suite
   * has a real field for it, and it was previously reachable only by opening
   * the settings sheet. Skills are the one strip slot with nowhere to write
   * here (there is no suite-level skills axis), so they stay hidden until the
   * suite is in environment mode.
   */
  const computersEnabled = useComputersEnabled();
  const handleSandboxImageChange = useCallback(
    async (next: string | null) => {
      try {
        await updateSuite({
          suiteId: suite._id,
          // Whole-object replace: `servers`/`serverBindings` are re-sent so
          // setting an image doesn't wipe them, and clearing works by omitting
          // the key rather than sending null.
          environment: {
            servers: suite.environment?.servers ?? [],
            serverBindings: suite.environment?.serverBindings,
            ...(next ? { computerEnvironmentId: next } : {}),
          },
        });
        toast.success(next ? "Computer image set" : "Computer image cleared");
      } catch (error) {
        toast.error(convexErrMessage(error, "Failed to update the suite"));
      }
    },
    [suite._id, suite.environment?.serverBindings, suite.environment?.servers, updateSuite]
  );

  const hostIds = attachments.map((a) => a.namedHostId);

  const handleClientsChange = (nextHostIds: string[]) => {
    // A suite with no clients cannot run; refuse the last detach rather than
    // letting the bar fall into an unrunnable state.
    if (nextHostIds.length === 0) return;
    const byId = new Map(attachments.map((a) => [a.namedHostId, a]));
    void persist(
      nextHostIds.map(
        (namedHostId) =>
          byId.get(namedHostId) ?? {
            namedHostId,
            enabledOptionalServerIds: [],
          }
      )
    );
  };

  const showServers = Boolean(
    suite.projectId && (editable || suite.serverAttachment)
  );

  return (
    <>
      {showServers ? (
        <div className="shrink-0">
          {editable && suite.projectId && onUpdateServerAttachment ? (
            <ServerPicker
              projectId={suite.projectId}
              value={suite.serverAttachmentId ?? null}
              onChange={onUpdateServerAttachment}
            />
          ) : suite.serverAttachment ? (
            <span className="flex h-8 items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 text-xs font-medium text-foreground">
              <Globe className="size-3.5 shrink-0 text-muted-foreground" />
              {suite.serverAttachment.name}
              <span className="text-[10px] text-muted-foreground">
                · {suite.serverAttachment.serverIds.length} server
                {suite.serverAttachment.serverIds.length === 1 ? "" : "s"}
              </span>
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {editable && suite.projectId ? (
          <ClientsPill
            projectId={suite.projectId}
            value={hostIds}
            onChange={handleClientsChange}
            max={MAX_SUITE_ENVIRONMENTS}
            testId="suite-env-clients-picker"
          />
        ) : attachments.length === 0 ? (
          <span className="shrink-0 text-[13px] font-normal text-muted-foreground">
            No clients attached
          </span>
        ) : (
          attachments.map((attachment) => {
            const label =
              (suite.hostAttachments ?? []).find(
                (a) => a.namedHostId === attachment.namedHostId
              )?.hostName ?? attachment.namedHostId;
            return (
              <div
                key={attachment.namedHostId}
                className="flex h-8 max-w-[260px] shrink-0 items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 text-foreground"
              >
                <Server className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                  {label}
                </span>
              </div>
            );
          })
        )}
      </div>

      {computersEnabled && !omitComputers && editable && suite.projectId ? (
        <div className="shrink-0">
          <SandboxImagePill
            projectId={suite.projectId}
            value={suite.environment?.computerEnvironmentId ?? null}
            onChange={(next) => void handleSandboxImageChange(next)}
            testId="suite-env-sandbox-image"
          />
        </div>
      ) : null}
    </>
  );
}
