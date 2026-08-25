/**
 * Full-page create-suite flow at `/evals/create`.
 *
 * Replaces the old CreateSuiteDialog modal. Mutation, payload, and post-create
 * navigation stay with the caller; this page owns chrome, prefill, and the
 * shared environment lego strip.
 */
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useConvexAuth } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@mcpjam/design-system/breadcrumb";
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
  type ComposerSlot,
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
import { RequiredMark } from "@/components/shared/required-mark";
import { toast } from "@/lib/toast";
import type { HostAttachmentDraft } from "../evals/client-attachments-editor";
import {
  DEFAULT_CREATE_SUITE_NAME,
  pickServerAttachmentIdForServer,
  seedCreateSuiteName,
} from "./create-suite-prefill";

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
   * Resolved environments, when the page composed them. Present ⇒ the suite
   * should be born in environment mode, which the caller does in a second call
   * (`createTestSuite` does not accept environments). The legacy fields above
   * are still sent alongside, so a failure between the two calls leaves a suite
   * that knows its clients rather than an empty skeleton.
   */
  environmentIds?: string[];
};

/** Servers as its own required field — one pill, matching the evals mock. */
export const EVALS_CREATE_SERVER_SLOTS: readonly ComposerSlot[] = ["servers"];

/** Where it runs: client + model side by side on the shared lego strip. */
export const EVALS_CREATE_RUNS_SLOTS: readonly ComposerSlot[] = [
  "clients",
  "models",
];

type CreateSuitePageProps = {
  onCancel: () => void;
  onSubmit: (payload: CreateSuitePayload) => Promise<void>;
  hostsEnabled?: boolean;
  projectId?: string | null;
  /**
   * Name prefill applied on mount (the agent's `ui_open_eval_suite_form`
   * prefill-over-commit path, and the empty-hero "start from this server"
   * cards). The user can still edit or clear it before submitting.
   */
  initialName?: string | null;
  /**
   * When set, select a server group that contains this project server
   * instead of defaulting to the first group. Used by the Evaluate empty
   * hero so "Create suite" on a server card opens already attached to it.
   * Name-only prefills (the agent command) leave this unset on purpose.
   */
  initialServerId?: string | null;
};

export function CreateSuitePage({
  onCancel,
  onSubmit,
  hostsEnabled = false,
  projectId = null,
  initialName = null,
  initialServerId = null,
}: CreateSuitePageProps) {
  const [name, setName] = useState(() => seedCreateSuiteName(initialName));
  const [isSaving, setIsSaving] = useState(false);
  const [target, setTarget] = useState<EnvironmentComposerState>(
    emptyComposerState,
  );

  const environmentsEnabled = useProjectEnvironmentsEnabled();
  /**
   * Born in environment mode. A suite created legacy can be converted from the
   * header later, but starting there means the axes the page offers are the
   * ones its runs will actually read.
   */
  const composeMode = Boolean(projectId) && environmentsEnabled;
  const resolveTargets = useComposerResolver(projectId ?? "");
  const composerEnvironments = useProjectEnvironments(
    composeMode ? projectId : null,
  );

  const { isAuthenticated } = useConvexAuth();
  const shouldFetchDefaults = hostsEnabled && projectId !== null;
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

  const appliedInitialNameRef = useRef(initialName);
  useEffect(() => {
    if (!initialName || initialName === appliedInitialNameRef.current) return;
    appliedInitialNameRef.current = initialName;
    setName(initialName);
  }, [initialName]);

  const appliedInitialServerRef = useRef(false);
  useEffect(() => {
    if (!initialServerId || !shouldFetchDefaults) return;
    if (appliedInitialServerRef.current) return;
    const match = pickServerAttachmentIdForServer(
      serverAttachments,
      initialServerId,
    );
    if (!match) return;
    appliedInitialServerRef.current = true;
    setTarget((current) => ({
      ...current,
      stack: { ...current.stack, serverAttachmentId: match },
      customized: true,
    }));
  }, [initialServerId, shouldFetchDefaults, serverAttachments]);

  useEffect(() => {
    if (!shouldFetchDefaults) return;
    if (initialServerId) return;
    if (target.stack.serverAttachmentId !== null) return;
    if (serverAttachments.length === 0) return;
    setTarget((current) =>
      current.stack.serverAttachmentId !== null
        ? current
        : {
            ...current,
            stack: {
              ...current.stack,
              serverAttachmentId: serverAttachments[0]._id,
            },
            customized: true,
          },
    );
  }, [
    shouldFetchDefaults,
    initialServerId,
    serverAttachments,
    target.stack.serverAttachmentId,
  ]);

  const seededHostRef = useRef(false);
  useEffect(() => {
    if (!shouldFetchDefaults) return;
    if (hosts.length === 0) return;
    if (target.stack.hostIds.length > 0 || target.environmentIds.length > 0) {
      seededHostRef.current = true;
      return;
    }
    if (seededHostRef.current) return;
    const preferred =
      hosts.find((h) => h.hostId === previewedHostId) ?? hosts[0];
    seededHostRef.current = true;
    setTarget((current) =>
      current.stack.hostIds.length > 0 || current.environmentIds.length > 0
        ? current
        : {
            ...current,
            stack: { ...current.stack, hostIds: [preferred.hostId] },
            customized: true,
          },
    );
  }, [
    shouldFetchDefaults,
    hosts,
    previewedHostId,
    target.stack.hostIds.length,
    target.environmentIds.length,
  ]);

  // NO model seeding. The stack's model axis defaults to
  // `includeClientDefaults: true` — one inherit cell per client, which IS
  // "run the client's own model". Writing the previewed host's `modelId` in as
  // an EXPLICIT pick would look identical on screen and resolve differently:
  // the environment fingerprint treats explicit-equals-default as its own row,
  // so seeding here would mint a duplicate ad-hoc environment for every suite
  // created from this page. The user opts into an override via the models pill.

  const attachmentsRequired = hostsEnabled && projectId !== null;
  const composeHasTarget = composerHasTarget(target);
  const hasServer = target.stack.serverAttachmentId !== null;
  const hasRequiredAttachments = attachmentsRequired
    ? hasServer &&
      (composeMode ? composeHasTarget : target.stack.hostIds.length > 0)
    : true;
  const composerReady = !composeMode || composerEnvironments !== undefined;
  const canSubmit =
    name.trim().length > 0 &&
    hasRequiredAttachments &&
    composerReady &&
    !isSaving;

  const blockReason: string | null = (() => {
    if (canSubmit || isSaving) return null;
    if (name.trim().length === 0) return "Add a suite name first.";
    if (!composerReady) return "Loading this project's environments…";
    if (attachmentsRequired && !hasServer) {
      return target.stack.hostIds.length === 0
        ? "Pick a server group and a client first."
        : "Pick a server group first.";
    }
    if (attachmentsRequired && target.stack.hostIds.length === 0) {
      return "Choose a client first.";
    }
    return null;
  })();

  const handleSubmit = async () => {
    if (!canSubmit) {
      return;
    }

    setIsSaving(true);
    let payload: CreateSuitePayload;
    if (composeMode) {
      try {
        const resolved = await resolveTargets({
          state: target,
          liveEnvironments: composerEnvironments ?? [],
          max: MAX_SUITE_ENVIRONMENTS,
        });
        const fallbackHostIds = [
          ...new Set(resolved.environments.map((env) => env.hostId)),
        ];
        const resolvedGroups = new Set(
          resolved.environments.map((env) => env.serverAttachmentId ?? null),
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
        ...(target.stack.hostIds.length > 0
          ? {
              hostAttachments: target.stack.hostIds.map((namedHostId) => ({
                namedHostId,
                enabledOptionalServerIds: initialServerId
                  ? [initialServerId]
                  : [],
              })),
            }
          : {}),
        ...(target.stack.serverAttachmentId
          ? { serverAttachmentId: target.stack.serverAttachmentId }
          : {}),
      };
    }

    try {
      await onSubmit(payload);
    } catch {
      // onSubmit surfaces its own error toast; keep the page open so the
      // user can retry, but don't propagate as an unhandled rejection.
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="create-suite-page"
    >
      <div className="shrink-0 border-b border-border/60 bg-muted/15 px-4 py-2.5 sm:px-6">
        <Breadcrumb className="min-w-0">
          <BreadcrumbList className="min-w-0 flex-nowrap">
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <button
                  type="button"
                  className="inline-flex border-0 bg-transparent p-0 font-medium text-muted-foreground hover:text-foreground"
                  onClick={onCancel}
                >
                  Evaluate
                </button>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage className="font-semibold">
                New suite
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-background">
        <div className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-8 sm:px-8">
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-[-0.02em] text-foreground">
              Create a new eval suite
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Set up the environment you will be evaluating.
            </p>
          </div>

          <div className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="create-suite-name">
                Suite name <RequiredMark />
              </Label>
              <Input
                id="create-suite-name"
                data-testid="create-suite-name"
                aria-required
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={DEFAULT_CREATE_SUITE_NAME}
                disabled={isSaving}
              />
            </div>

            {hostsEnabled && projectId ? (
              <>
                <div className="space-y-2">
                  <Label>
                    Servers <RequiredMark />
                  </Label>
                  <EnvironmentComposer
                    projectId={projectId}
                    environments={composerEnvironments ?? []}
                    value={target}
                    onChange={setTarget}
                    maxTargets={MAX_SUITE_ENVIRONMENTS}
                    disabled={isSaving}
                    testIdPrefix="create-suite-servers"
                    slots={EVALS_CREATE_SERVER_SLOTS}
                    emptyServerLabel="No server group · pick one"
                    serverInfoText="A named set of MCP servers this suite runs against."
                  />
                </div>

                <div className="space-y-2">
                  <Label>
                    Where it runs <RequiredMark />
                  </Label>
                  <EnvironmentComposer
                    projectId={projectId}
                    environments={composerEnvironments ?? []}
                    value={target}
                    onChange={setTarget}
                    maxTargets={MAX_SUITE_ENVIRONMENTS}
                    disabled={isSaving}
                    testIdPrefix="create-suite"
                    slots={EVALS_CREATE_RUNS_SLOTS}
                  />
                </div>
              </>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/40 pt-4">
            <Button
              type="button"
              variant="ghost"
              onClick={onCancel}
              disabled={isSaving}
              data-testid="create-suite-cancel"
            >
              Cancel
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={blockReason ? 0 : -1}>
                  <Button
                    type="button"
                    onClick={() => void handleSubmit()}
                    disabled={!canSubmit}
                    data-testid="create-suite-continue"
                  >
                    {isSaving ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : null}
                    Continue
                  </Button>
                </span>
              </TooltipTrigger>
              {blockReason ? (
                <TooltipContent side="top">
                  <p className="text-xs">{blockReason}</p>
                </TooltipContent>
              ) : null}
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
}
