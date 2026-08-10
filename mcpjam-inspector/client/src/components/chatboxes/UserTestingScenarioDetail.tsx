import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  Layers,
  Link2,
  PenLine,
  Trash2,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { CloudRunBadge } from "@/components/computer/CloudRunBadge";
import { ViewModeSelector } from "@/components/shared/view-mode-selector";
import { useComputersEnabled } from "@/hooks/useComputersEnabled";
import { ChatboxShareSection } from "@/components/chatboxes/ChatboxShareSection";
import { ChatboxUsagePanel } from "@/components/chatboxes/ChatboxUsagePanel";
import { ChatboxPreviewPane } from "@/components/chatboxes/ChatboxPreviewPane";
import { ChatboxDeleteConfirmDialog } from "@/components/chatboxes/ChatboxDeleteConfirmDialog";
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
  getChatboxHostLabel,
  getChatboxHostLogo,
} from "@/lib/chatbox-client-style";
import {
  buildUserTestingScenarioPath,
  parseUserTestingDetailTab,
  type UserTestingDetailTab,
} from "@/lib/app-navigation";
import { buildChatboxLink } from "@/lib/chatbox-session";
import { copyToClipboard } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { cn } from "@/lib/utils";

/**
 * One User Testing scenario: the share band on top, then what came back from it.
 *
 * Clusters are per-scenario for free — `ChatboxUsagePanel` is chatbox-scoped,
 * so the topic map here only ever covers this scenario's own sessions. There is
 * deliberately no project-wide clusters view: aggregating across scenarios that
 * point at different servers would produce themes nobody can act on.
 *
 * Preview embeds the live share link, which means opening that tab starts a
 * REAL guest session against this scenario — it shows up in Sessions and in
 * guest analytics like any tester's. That's why it mounts lazily (opening a
 * scenario costs nothing) and why the embed tags itself `?surface=preview`
 * (so the session it starts is labelled rather than passing for a tester's).
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
  { value: "sessions", label: "Sessions" },
  { value: "clusters", label: "Clusters" },
  { value: "preview", label: "Preview" },
];

export function UserTestingScenarioDetail({
  chatbox,
  isAuthenticated,
  onBack,
  onDeleted,
}: UserTestingScenarioDetailProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const computersEnabled = useComputersEnabled();
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const { deleteChatbox, updateChatbox, rebindEnvironmentChatbox } =
    useChatboxMutations();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [nameEnvironmentOpen, setNameEnvironmentOpen] = useState(false);

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
  const sessionDeepLinkThreadId = new URLSearchParams(location.search).get(
    "session",
  );

  const environmentName = chatbox.environmentName ?? null;
  // Present only when the environment can't resolve right now (archived, a
  // pinned plugin disabled, its host gone). The scenario still opens: its
  // sessions are history worth reading, and unpublishing it is the action
  // this state calls for.
  const environmentError = chatbox.environmentError ?? null;

  const publishLink = chatbox.link?.token
    ? buildChatboxLink(chatbox.link.token, chatbox.name)
    : null;
  const displayLink = publishLink?.replace(/^https?:\/\//, "") ?? null;

  // Preview embeds the live share link, so it starts a real guest session.
  // Mount it only once the tab has been opened — and then keep it mounted
  // (hidden) so flipping back to Sessions and returning doesn't start a
  // second one. A deep link straight to `?tab=preview` opens it immediately.
  const [hasOpenedPreview, setHasOpenedPreview] = useState(tab === "preview");
  useEffect(() => {
    if (tab === "preview") setHasOpenedPreview(true);
  }, [tab]);

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
    // button between the scenario and the list. Drops `?session=` — that
    // selection belongs to the Sessions tab.
    navigate(buildUserTestingScenarioPath(chatbox.chatboxId, { tab: next }), {
      replace: true,
    });
  };

  const handleCopyLink = async () => {
    if (!publishLink) return;
    const ok = await copyToClipboard(publishLink);
    if (ok) toast.success("Share link copied");
    else toast.error("Failed to copy share link");
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
      <div className="shrink-0 border-b border-border/40 px-6 py-4 sm:px-8">
        <button
          type="button"
          onClick={onBack}
          data-testid="user-testing-detail-back"
          className={cn(
            "inline-flex items-center gap-1 rounded-sm text-sm font-medium text-primary",
            "hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <ArrowLeft className="size-3.5" />
          User Testing
        </button>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <EditableTitle
              value={chatbox.name}
              onSave={handleRename}
              variant="h1"
              fullWidth
              placeholder="Scenario name"
              className="-ml-2 px-2 text-xl font-semibold tracking-tight"
              inputClassName="text-xl font-semibold tracking-tight"
            />
            {composerActive ? (
              // The scenario's setup, editable in place. Each pill edit
              // resolves to a real environment row and REBINDS the scenario —
              // "same setup, different server group" is one pill change on a
              // live share link, not a trip to /environments.
              <div className="mt-2 min-w-0">
                <EnvironmentComposer
                  projectId={chatbox.projectId}
                  environments={liveNamedEnvironments}
                  value={composer}
                  onChange={handleComposerChange}
                  maxTargets={1}
                  disabled={isRebinding || !composerReady}
                  testIdPrefix="user-testing-detail"
                />
                <div className="mt-1.5 flex items-center gap-2 text-sm text-muted-foreground">
                  {environmentIsAdhoc ? (
                    // The row behind this setup is ad-hoc: content-addressed,
                    // immutable, labeled by its client rather than a name.
                    // Naming it (in place, same id) turns it into a curated
                    // environment other surfaces can pick.
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 shrink-0 px-2 text-xs text-muted-foreground"
                      onClick={() => setNameEnvironmentOpen(true)}
                      data-testid="user-testing-name-environment"
                    >
                      <PenLine className="mr-1 size-3" />
                      Name environment
                    </Button>
                  ) : null}
                  {computersEnabled ? (
                    <CloudRunBadge
                      tooltip="Tester computer commands run in per-conversation MCPJam cloud sandboxes — never on the machine serving this inspector."
                      data-testid="user-testing-cloud-run-badge"
                    />
                  ) : null}
                </div>
              </div>
            ) : (
            <div className="mt-1.5 flex items-center gap-2 text-sm text-muted-foreground">
              {environmentName ? (
                // Environment-backed but the composer can't run here (flag
                // off, or the row hasn't loaded / isn't visible): the static
                // identity row.
                <>
                  <Layers className="size-4 shrink-0" />
                  <span className="truncate font-medium text-foreground">
                    {environmentName}
                  </span>
                </>
              ) : (
                <>
                  <span className="inline-flex size-5 items-center justify-center overflow-hidden rounded-sm border border-border/50 bg-background">
                    <img
                      src={getChatboxHostLogo(
                        chatbox.hostStyle,
                        undefined,
                        themeMode,
                      )}
                      alt=""
                      className="size-3.5 object-contain"
                    />
                  </span>
                  <span className="font-medium text-foreground">
                    {getChatboxHostLabel(chatbox.hostStyle)}
                  </span>
                  <span aria-hidden="true" className="text-muted-foreground/40">
                    ·
                  </span>
                  <span className="truncate">{chatbox.namedHostName}</span>
                </>
              )}
              {computersEnabled ? (
                <CloudRunBadge
                  tooltip="Tester computer commands run in per-conversation MCPJam cloud sandboxes — never on the machine serving this inspector."
                  data-testid="user-testing-cloud-run-badge"
                />
              ) : null}
            </div>
            )}
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
                "mt-1 min-h-0 resize-none border-0 bg-transparent px-0 py-0 text-sm",
                "text-muted-foreground shadow-none placeholder:text-muted-foreground/60",
                "focus-visible:border-0 focus-visible:ring-0",
              )}
            />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {publishLink ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open(publishLink, "_blank", "noopener")}
              >
                <ExternalLink className="mr-1.5 size-4" />
                Open
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="mr-1.5 size-4" />
              Delete
            </Button>
          </div>
        </div>

        {environmentError ? (
          <div
            data-testid="user-testing-detail-environment-error"
            className="mt-4 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500" />
            <div className="min-w-0 text-sm">
              <p className="font-medium text-foreground">
                {environmentError.code === "ENV_ARCHIVED"
                  ? "This scenario's environment is archived — the share link no longer opens."
                  : "This scenario's environment can't be loaded right now — the share link won't open."}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {environmentError.message} Its sessions below are unaffected.
              </p>
            </div>
          </div>
        ) : null}

        <div className="mt-4 flex flex-col gap-3 rounded-md border border-primary/20 bg-primary/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Share this with testers
            </p>
            {displayLink ? (
              <p className="mt-1 truncate text-base font-semibold text-foreground">
                {displayLink}
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                No share link yet.
              </p>
            )}
          </div>
          <Button
            size="sm"
            disabled={!publishLink}
            onClick={() => void handleCopyLink()}
          >
            <Link2 className="mr-1.5 size-4" />
            Copy link
          </Button>
        </div>

        <div className="mt-4">
          <ChatboxShareSection chatbox={chatbox} />
        </div>

        <nav className="mt-5">
          <ViewModeSelector
            value={tab}
            options={TAB_OPTIONS}
            onChange={goToTab}
            ariaLabel="Scenario view"
            indicatorId="user-testing-detail"
          />
        </nav>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {tab === "sessions" ? (
          <div className="absolute inset-0">
            <ChatboxUsagePanel
              chatbox={chatbox}
              section="sessions"
              initialThreadId={sessionDeepLinkThreadId}
            />
          </div>
        ) : null}
        {tab === "clusters" ? (
          <div className="absolute inset-0">
            <ChatboxUsagePanel
              chatbox={chatbox}
              section="insights"
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
            />
          </div>
        ) : null}
        {hasOpenedPreview ? (
          // Hidden rather than unmounted: re-mounting would abandon the
          // tester session already running in the frame and start another.
          <div
            className={cn("absolute inset-0", tab === "preview" ? "" : "hidden")}
          >
            {isPreviewProfilePending ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Loading preview…
              </div>
            ) : (
              <ChatboxPreviewPane
                publishLink={environmentError ? null : publishLink}
                mcpProfile={previewHost?.config.mcpProfile}
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
    </div>
  );
}
