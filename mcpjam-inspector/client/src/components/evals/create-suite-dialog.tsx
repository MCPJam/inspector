import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useConvexAuth } from "convex/react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { useProjectServerAttachments } from "@/hooks/useViews";
import { useHostList } from "@/hooks/useClients";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import {
  EnvironmentComposer,
  EVALS_COMPOSER_SLOTS,
} from "@/components/environment-composer/environment-composer";
import {
  composerHasTarget,
  emptyComposerState,
  type EnvironmentComposerState,
} from "@/components/environment-composer/environment-stack";
import { useComposerResolver } from "@/components/environment-composer/use-composer-resolver";
import { MAX_SUITE_ENVIRONMENTS } from "@/components/project-environments/environment-picker";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import { useProjectEnvironments } from "@/hooks/useProjectEnvironments";
import { toast } from "@/lib/toast";
import {
  ClientAttachmentsEditor,
  type HostAttachmentDraft,
} from "./client-attachments-editor";
import { ServerAttachmentPicker } from "./server-attachment-picker";

export type CreateSuitePayload = {
  name: string;
  /**
   * Hosts the suite runs against. Each attachment fans out into its own
   * run on "Run all hosts" — the host's snapshotted config is the source
   * of truth for model, system prompt, temperature, and servers. There is
   * no longer a suite-level flat server list or model override.
   */
  hostAttachments?: HostAttachmentDraft[];
  /** Standalone server attachment shared across all runs of this suite. */
  serverAttachmentId?: string;
  /**
   * Resolved environments, when the dialog composed them. Present ⇒ the suite
   * should be born in environment mode, which the caller does in a second call
   * (`createTestSuite` does not accept environments). The legacy fields above
   * are still sent alongside, so a failure between the two calls leaves a suite
   * that knows its clients rather than an empty skeleton.
   */
  environmentIds?: string[];
};

type CreateSuiteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: CreateSuitePayload) => Promise<void>;
  hostsEnabled?: boolean;
  projectId?: string | null;
  /**
   * Name prefill applied when the dialog OPENS (the agent's
   * `ui_open_eval_suite_form` prefill-over-commit path). Name only, on
   * purpose: everything else in the form is the user's to pick. The user
   * can still edit or clear it before submitting.
   */
  initialName?: string | null;
};

export function CreateSuiteDialog({
  open,
  onOpenChange,
  onSubmit,
  hostsEnabled = false,
  projectId = null,
  initialName = null,
}: CreateSuiteDialogProps) {
  const [name, setName] = useState("");
  const [hostAttachments, setHostAttachments] = useState<
    HostAttachmentDraft[]
  >([]);
  const [serverAttachmentId, setServerAttachmentId] = useState<string | null>(
    null,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [target, setTarget] = useState<EnvironmentComposerState>(
    emptyComposerState,
  );

  const environmentsEnabled = useProjectEnvironmentsEnabled();
  /**
   * Born in environment mode. A suite created legacy can be converted from the
   * header later, but starting there means the axes the dialog offers are the
   * ones its runs will actually read.
   */
  const composeMode = Boolean(projectId) && environmentsEnabled;
  // Only used when `composeMode`; `projectId` is non-null in that case.
  const resolveTargets = useComposerResolver(projectId ?? "");
  const composerEnvironments = useProjectEnvironments(
    composeMode ? projectId : null,
  );

  const { isAuthenticated } = useConvexAuth();
  const shouldFetchDefaults = open && hostsEnabled && projectId !== null;
  const { serverAttachments } = useProjectServerAttachments({
    isAuthenticated: isAuthenticated && shouldFetchDefaults,
    projectId: shouldFetchDefaults ? projectId : null,
  });
  const { hosts } = useHostList({
    isAuthenticated: isAuthenticated && shouldFetchDefaults,
    projectId: shouldFetchDefaults ? projectId : null,
  });
  const [previewedHostId] = usePreviewedHostId(
    shouldFetchDefaults ? projectId : null,
  );

  const wasOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!open) {
      setName("");
      setHostAttachments([]);
      setServerAttachmentId(null);
      setTarget(emptyComposerState());
      setIsSaving(false);
    } else if (justOpened && initialName) {
      // Applied ONLY on the closed→open transition. A parent that changes
      // initialName while the dialog is open must not clobber the user's
      // edits, so this deliberately does not re-apply on initialName change.
      setName(initialName);
    }
  }, [open, initialName]);

  useEffect(() => {
    // Compose mode picks its own defaults through the composer; seeding the
    // legacy server group here would send a field its runs never read.
    if (!shouldFetchDefaults || composeMode) return;
    if (serverAttachmentId === null && serverAttachments.length > 0) {
      setServerAttachmentId(serverAttachments[0]._id);
    }
  }, [
    composeMode,
    shouldFetchDefaults,
    serverAttachmentId,
    serverAttachments,
  ]);

  useEffect(() => {
    if (!shouldFetchDefaults) return;
    if (hosts.length === 0) return;
    const preferred =
      hosts.find((h) => h.hostId === previewedHostId) ?? hosts[0];
    if (composeMode) {
      // Same default, expressed as a stack: a suite almost always starts on the
      // client the user was just looking at.
      setTarget((current) =>
        current.stack.hostIds.length > 0 || current.environmentIds.length > 0
          ? current
          : {
              ...current,
              stack: { ...current.stack, hostIds: [preferred.hostId] },
              customized: true,
            },
      );
      return;
    }
    if (hostAttachments.length > 0) return;
    setHostAttachments([
      { namedHostId: preferred.hostId, enabledOptionalServerIds: [] },
    ]);
  }, [
    composeMode,
    shouldFetchDefaults,
    hostAttachments.length,
    hosts,
    previewedHostId,
  ]);

  const attachmentsRequired = hostsEnabled && projectId !== null;
  // Keyed on the ACTIVE mode, not on "something is selected" — see
  // `composerHasTarget`. Create would otherwise stay enabled on a state that can
  // only fail resolution.
  const composeHasTarget = composerHasTarget(target);
  const hasRequiredAttachments = composeMode
    ? composeHasTarget
    : !attachmentsRequired ||
      (serverAttachmentId !== null && hostAttachments.length > 0);
  // Compose mode also waits for the environment list: the resolver reuses a
  // matching NAMED environment, and against an empty live list it finds none and
  // mints an unnamed duplicate — attaching the new suite to the wrong identity.
  const composerReady = !composeMode || composerEnvironments !== undefined;
  const canSubmit =
    name.trim().length > 0 &&
    hasRequiredAttachments &&
    composerReady &&
    !isSaving;

  const blockReason: string | null = (() => {
    if (canSubmit || isSaving) return null;
    if (name.trim().length === 0) return "Add a suite name first.";
    if (composeMode && !composeHasTarget) {
      return "Pick an environment or at least one client first.";
    }
    if (!composerReady) return "Loading this project's environments…";
    if (attachmentsRequired && serverAttachmentId === null) {
      return hostAttachments.length === 0
        ? "Attach a server and at least one client first."
        : "Pick a server group first.";
    }
    if (attachmentsRequired && hostAttachments.length === 0) {
      return "Attach at least one client first.";
    }
    return null;
  })();

  const handleSubmit = async () => {
    if (!canSubmit) {
      return;
    }

    setIsSaving(true);
    // Resolve BEFORE creating anything, so a composition that cannot become
    // rows never leaves a suite behind. Its own catch: `onSubmit` reports its
    // failures, a resolve failure has nobody else to report it.
    let payload: CreateSuitePayload;
    if (composeMode) {
      try {
        const resolved = await resolveTargets({
          state: target,
          liveEnvironments: composerEnvironments ?? [],
          max: MAX_SUITE_ENVIRONMENTS,
        });
        // Legacy fields ride along as rollback data, the way journey writes keep
        // theirs from going stale — built from the RESOLVED environments, not
        // from the stack. Picking two saved environments seeds the stack from
        // only one of them, so a stack-derived fallback would name one client
        // for a two-target suite and quietly drop the other if the second call
        // failed.
        const fallbackHostIds = [
          ...new Set(resolved.environments.map((env) => env.hostId)),
        ];
        const resolvedGroups = new Set(
          resolved.environments.map((env) => env.serverAttachmentId ?? null)
        );
        const fallbackServerAttachmentId =
          resolvedGroups.size === 1
            ? ([...resolvedGroups][0] ?? undefined)
            : undefined;
        payload = {
          name: name.trim(),
          environmentIds: resolved.environmentIds,
          ...(fallbackHostIds.length > 0
            ? {
                hostAttachments: fallbackHostIds.map((namedHostId) => ({
                  namedHostId,
                  enabledOptionalServerIds: [],
                })),
              }
            : {}),
          // Only when every resolved environment agrees. A stack-derived value
          // would impose the last-selected environment's server group on every
          // restored host, so a rollback suite would run something the user never
          // chose. Omitting it is honest: the legacy fields simply cannot
          // represent a heterogeneous selection.
          ...(fallbackServerAttachmentId
            ? { serverAttachmentId: fallbackServerAttachmentId }
            : {}),
        };
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : "Could not resolve where this suite runs.",
        );
        setIsSaving(false);
        return;
      }
    } else {
      payload = {
        name: name.trim(),
        ...(hostAttachments.length > 0 ? { hostAttachments } : {}),
        ...(serverAttachmentId ? { serverAttachmentId } : {}),
      };
    }

    try {
      await onSubmit(payload);
    } catch {
      // onSubmit surfaces its own error toast; keep the dialog open so the
      // user can retry, but don't propagate as an unhandled rejection.
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Create suite</DialogTitle>
          <DialogDescription>
            Name your suite and pick what it runs against. You can change
            this later.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-1.5">
            <label className="text-xs font-medium text-foreground">
              Suite name
            </label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Customer support workflows"
            />
          </div>

          {composeMode && projectId ? (
            <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
              <div className="space-y-0.5">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Where it runs
                </h3>
                <p className="text-xs text-muted-foreground">
                  Start from an environment, or build one here. Each client fans
                  out into its own run.
                </p>
              </div>
              <EnvironmentComposer
                projectId={projectId}
                environments={composerEnvironments ?? []}
                value={target}
                onChange={setTarget}
                maxTargets={MAX_SUITE_ENVIRONMENTS}
                disabled={isSaving}
                testIdPrefix="create-suite"
                inModal
                slots={EVALS_COMPOSER_SLOTS}
                clientDefaultLabel={
                  (() => {
                    const previewed =
                      hosts.find((h) => h.hostId === previewedHostId) ??
                      hosts[0];
                    return previewed?.modelId ?? null;
                  })()
                }
              />
            </div>
          ) : hostsEnabled && projectId ? (
            <div className="divide-y rounded-lg border bg-muted/20">
              <div className="flex items-start justify-between gap-4 p-3">
                <div className="min-w-0 space-y-0.5">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Servers
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Server group all hosts run against.
                  </p>
                </div>
                <div className="shrink-0">
                  <ServerAttachmentPicker
                    projectId={projectId}
                    value={serverAttachmentId}
                    onChange={setServerAttachmentId}
                    onClearSelection={() => setServerAttachmentId(null)}
                    inModal
                    disabled={isSaving}
                  />
                </div>
              </div>
              <div className="space-y-2 p-3">
                <div className="space-y-0.5">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Clients
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Each attached client fans out into its own run.
                  </p>
                </div>
                <ClientAttachmentsEditor
                  projectId={projectId}
                  value={hostAttachments}
                  onChange={setHostAttachments}
                  disabled={isSaving}
                />
              </div>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              {/* span wrapper lets the tooltip catch hover/focus even when the button is disabled */}
              <span tabIndex={blockReason ? 0 : -1}>
                <Button
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={!canSubmit}
                >
                  {isSaving ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  Create suite
                </Button>
              </span>
            </TooltipTrigger>
            {blockReason ? (
              <TooltipContent side="top">
                <p className="text-xs">{blockReason}</p>
              </TooltipContent>
            ) : null}
          </Tooltip>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
