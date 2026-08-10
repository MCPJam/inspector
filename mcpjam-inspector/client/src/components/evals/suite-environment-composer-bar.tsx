/**
 * The suite header's "where this runs" bar.
 *
 * One strip, two write modes, because a suite can express its target two ways:
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
import { EnvironmentComposer } from "@/components/environment-composer/environment-composer";
import {
  composerStateFromEnvironments,
  type EnvironmentComposerState,
} from "@/components/environment-composer/environment-stack";
import { useComposerResolver } from "@/components/environment-composer/use-composer-resolver";
import { CompareClientsButton } from "@/components/evals/compare-clients-button";
import { ServerGroupPicker } from "@/components/hosts/ServerGroupPicker";
import { MAX_SUITE_ENVIRONMENTS } from "@/components/project-environments/environment-picker";
import { useAdhocEnvironmentsEnabled } from "@/hooks/useAdhocEnvironmentsEnabled";
import { useProjectEnvironments } from "@/hooks/useProjectEnvironments";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
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
  /** `panel` = card surface. `inline` = no chrome, for the header row. */
  containerVariant?: "panel" | "inline";
}

export function SuiteEnvironmentComposerBar({
  suite,
  readOnly = false,
  onUpdate,
  onUpdateServerAttachment,
  className,
  containerVariant = "panel",
}: SuiteEnvironmentComposerBarProps) {
  const projectId = suite.projectId ?? null;
  const environmentsEnabled = useProjectEnvironmentsEnabled();
  const adhocEnabled = useAdhocEnvironmentsEnabled();
  // Environments are project-scoped, so a suite without a project can only ever
  // run the legacy axes — no flag makes that untrue.
  const envCapable = Boolean(projectId) && environmentsEnabled && adhocEnabled;

  const editable = !readOnly && Boolean(onUpdate);

  return envCapable && projectId ? (
    <BarShell className={className} containerVariant={containerVariant}>
      <EnvironmentModeBar
        suite={suite}
        projectId={projectId}
        disabled={!editable}
      />
    </BarShell>
  ) : (
    <BarShell className={className} containerVariant={containerVariant}>
      <LegacyModeBar
        suite={suite}
        editable={editable}
        onUpdate={onUpdate}
        onUpdateServerAttachment={onUpdateServerAttachment}
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
}: {
  suite: EvalSuite;
  projectId: string;
  disabled: boolean;
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
  /**
   * An attachment that no live row resolves — archived, or deleted out from
   * under the suite. Every edit here rewrites `environmentIds` wholesale, so
   * proceeding would either silently drop it or be rejected by the backend's
   * liveness check. Neither is a thing to do behind the user's back.
   */
  const unresolvedCount = attachedIds.length - attachedEnvironments.length;

  const seeded = useMemo<EnvironmentComposerState>(() => {
    if (attachedIds.length > 0) {
      return composerStateFromEnvironments(attachedEnvironments);
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
      },
      customized: false,
    };
  }, [
    attachedEnvironments,
    attachedIds.length,
    suite.environment?.computerEnvironmentId,
    suite.hostAttachments,
    suite.serverAttachmentId,
  ]);

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
        // Resolve BEFORE writing: a failure mid-way leaves at most some
        // deduped ad-hoc rows nothing points at, never a half-updated suite.
        const resolved = await resolveTargets({
          state: next,
          liveEnvironments,
          max: MAX_SUITE_ENVIRONMENTS,
        });
        await setSuiteEnvironments({
          suiteId: suite._id,
          // The backend rejects an empty array; `null` is how a field clears.
          environmentIds:
            resolved.environmentIds.length > 0 ? resolved.environmentIds : null,
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
          disabled={disabled || saving || unresolvedCount > 0}
          testIdPrefix="suite-env"
        />
        <CompareClientsButton hostIds={state.stack.hostIds} />
      </div>
      {unresolvedCount > 0 ? (
        <p
          className="text-[11px] text-muted-foreground"
          data-testid="suite-env-unresolved-hint"
        >
          {unresolvedCount === 1
            ? "One attached environment is archived or unavailable."
            : `${unresolvedCount} attached environments are archived or unavailable.`}{" "}
          Detach it in suite settings before changing where this runs.
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
}: {
  suite: EvalSuite;
  editable: boolean;
  onUpdate?: (attachments: HostAttachmentDraft[]) => Promise<void>;
  onUpdateServerAttachment?: (serverAttachmentId: string) => Promise<void>;
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
            <ServerGroupPicker
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
        <CompareClientsButton hostIds={hostIds} />
      </div>
    </>
  );
}
