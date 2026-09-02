import { useAction, useConvexAuth, useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Loader2, Plus } from "lucide-react";
import { toast } from "@/lib/toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { RadioGroup, RadioGroupItem } from "@mcpjam/design-system/radio-group";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import type { EvalSuiteOverviewEntry } from "@/components/evals/types";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import {
  buildServerBasedSuiteName,
  normalizeServerNames,
} from "@/components/evals/suite-environment-utils";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import {
  useProjectServerAttachments,
  useProjectServers,
} from "@/hooks/useViews";
import { useHostList } from "@/hooks/useClients";
import type { HostAttachmentDraft } from "@/components/evals/client-attachments-editor";
import { ServerAttachmentPicker } from "@/components/evals/server-attachment-picker";
import { HostPicker } from "@/components/hosts/HostPicker";
import { CreateHostDialog } from "@/components/hosts/CreateHostDialog";
import { deriveSessionServerDisplay } from "./session-server-display";
import { cn } from "@/lib/utils";

/**
 * Source-agnostic identity of the session being promoted. `sessionId` is the
 * Convex `chatSessions` _id — exactly what `importChatSessionToTestCase`
 * takes; how it was obtained (direct-history DTO, swarm session row, …) is
 * the adapter's business.
 */
export type PromoteSessionSummary = {
  sessionId: string;
  /** Seed for the case title and the generated suite name. */
  title: string;
  projectId: string | null;
};

/**
 * Session-servers detail, resolved by the source adapter. `usedServerIds`
 * and `selectedServers` are SERVER-derived (direct: `/chat-history/detail`;
 * swarm: `chatSessionPromote:getChatSessionPromoteDetail`) — the core only
 * renders them.
 */
export type PromoteSessionDetailState = {
  loading: boolean;
  error: string | null;
  usedServerIds: string[];
  selectedServers: string[];
  /**
   * D8f2. True when promoting this session copies a THIRD PARTY's real words
   * into a durable, member-owned artifact — a real User Testing transcript.
   *
   * SERVER-DERIVED (`chatSessionPromote:getChatSessionPromoteDetail`), never
   * inferred here from a source type: the carve-out for synthetic sessions is
   * a policy decision and belongs where the policy lives. Absent on adapters
   * that predate the field and on surfaces the question does not apply to —
   * a Playground session is the promoter's own words, and asking someone to
   * acknowledge copying those is a dialog nobody reads, which teaches people
   * to click past the one that matters.
   */
  requiresContentTransferAcknowledgement?: boolean;
};

type ConvertSessionDialogCoreProps = {
  open: boolean;
  summary: PromoteSessionSummary | null;
  detail: PromoteSessionDetailState;
  isAuthenticated: boolean;
  /**
   * Pre-seed for the new-suite client attachment (e.g. the host a swarm
   * session actually ran on). Attachment selections stay CLIENT-supplied and
   * are validated by the backend on submit — unlike test-case provenance,
   * which the backend derives from the session row and never accepts from
   * the client. Falls back to the project's first host when absent/unknown.
   */
  defaultHostId?: string | null;
  /**
   * Whether the source adapter has resolved its authoritative host default.
   * Direct-history callers use the default (`true`) and fall back immediately;
   * async adapters pass `false` until their session detail arrives so a cached
   * project host cannot win the initial-render race.
   */
  hostDefaultResolved?: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (result: { suiteId: string; testCaseId: string }) => void;
};

type DestinationMode = "existing" | "new";

type DestinationCardProps = {
  value: DestinationMode;
  title: string;
  selected: boolean;
  disabled?: boolean;
  children: ReactNode;
};

/**
 * One "Add to" option: a radio and its fields in the same card, so the
 * fields visibly belong to the choice that reveals them. The unselected card
 * is just the radio and its name — the whole point of BB-163 is that the
 * other branch's inputs are not on screen asking to be filled in.
 *
 * The `<label>` deliberately covers only the radio and the title. The fields
 * are siblings: nesting them inside the label would hand every click on a
 * select to the radio.
 */
function DestinationCard({
  value,
  title,
  selected,
  disabled = false,
  children,
}: DestinationCardProps) {
  return (
    <div
      data-testid={`promote-destination-${value}`}
      data-selected={selected ? "true" : "false"}
      className={cn(
        "rounded-lg border bg-background p-3.5 transition-colors",
        selected ? "border-primary" : "border-border"
      )}
    >
      <label
        className={cn(
          "flex items-center gap-3",
          disabled ? "cursor-not-allowed" : "cursor-pointer"
        )}
      >
        <RadioGroupItem value={value} disabled={disabled} />
        <span className="text-sm font-medium text-card-foreground">
          {title}
        </span>
      </label>
      {selected ? <div className="mt-3 space-y-3">{children}</div> : null}
    </div>
  );
}

/**
 * Presentational/submit core of "Promote to test case". Owns the suite
 * pickers and the `importChatSessionToTestCase` call; per-source adapters
 * (`ConvertChatSessionDialog` for direct history, `ConvertPromotableSessionDialog`
 * for swarm runs) own fetching the summary/detail inputs.
 */
export function ConvertSessionDialogCore({
  open,
  summary,
  detail,
  isAuthenticated,
  defaultHostId,
  hostDefaultResolved = true,
  onOpenChange,
  onImported,
}: ConvertSessionDialogCoreProps) {
  const effectiveProjectId = summary?.projectId ?? null;
  // Mirror Create suite's `hostsEnabled` gate: the server/host attachment
  // pickers (and the new-suite branch's serverAttachmentId/hostAttachments
  // wiring) only apply in the unified-attachment world. Signed-out or
  // project-less sessions preserve the legacy path that #395 already covers.
  const { isAuthenticated: convexAuthed } = useConvexAuth();
  const isUserReady = useDbUserReady();
  const attachmentPickersEnabled =
    convexAuthed && isUserReady && Boolean(effectiveProjectId);
  // Authed with a project, but the `users` row is still bootstrapping: the
  // pickers DO apply to this session, their data just hasn't landed. Without
  // this, `newSuiteRequirementsMet` short-circuits on the disabled pickers and
  // imports into a legacy-shaped suite with nothing attached.
  const attachmentPickersPending =
    convexAuthed && !isUserReady && Boolean(effectiveProjectId);
  const {
    servers,
    serversById,
    isLoading: projectServersLoading,
  } = useProjectServers({
    isAuthenticated,
    projectId: effectiveProjectId,
  });
  const { serverAttachments: projectServerAttachments } =
    useProjectServerAttachments({
      isAuthenticated: attachmentPickersEnabled,
      projectId: attachmentPickersEnabled ? effectiveProjectId : null,
    });
  const { hosts: projectHosts } = useHostList({
    isAuthenticated: attachmentPickersEnabled,
    projectId: attachmentPickersEnabled ? effectiveProjectId : null,
  });
  const knownServerNames = useMemo(
    () => (servers ?? []).map((s) => s.name),
    [servers]
  );
  const suitesQueryActive = Boolean(open && isUserReady && effectiveProjectId);
  const suitesOverview = useQuery(
    "testSuites:getTestSuitesOverview" as any,
    suitesQueryActive ? ({ projectId: effectiveProjectId } as any) : "skip"
  ) as EvalSuiteOverviewEntry[] | undefined;
  /**
   * "We do not yet know what suites this project has" — which is NOT the same
   * question as `suitesOverview === undefined`.
   *
   * `useQuery` returns `undefined` both while loading and while skipped, and
   * the gate above skips on FOUR paths, not three. Signed out, no project and
   * closed are all genuinely "there are no suites to choose from". The fourth
   * — authed, with a project, `users` row still bootstrapping — is unknown,
   * and reading it as empty seeded the New suite branch and stamped the
   * default ref before the list could arrive, leaving a project that HAS
   * suites stuck on New suite for the life of the dialog.
   */
  const suitesPending =
    (suitesQueryActive && suitesOverview === undefined) ||
    attachmentPickersPending;
  const importChatSession = useAction(
    "testSuites:importChatSessionToTestCase" as any
  );

  const [caseTitle, setCaseTitle] = useState("");
  // Seeded per-session once the suite list resolves (see the default effect
  // below): "existing" when the project has suites, "new" when it does not.
  // The initial value only shows while `suitesPending`, which renders a
  // spinner instead of either branch.
  const [destinationMode, setDestinationMode] =
    useState<DestinationMode>("new");
  const [selectedSuiteId, setSelectedSuiteId] = useState<string>("");
  const [newSuiteName, setNewSuiteName] = useState("");
  const [updateSuiteEnvironment, setUpdateSuiteEnvironment] = useState(false);
  /**
   * Never pre-ticked, and reset whenever the dialog closes or the session
   * changes. A box that arrives already ticked records a decision nobody
   * made, and the whole value of the audit stamp is that someone made one.
   */
  const [contentTransferAcknowledged, setContentTransferAcknowledged] =
    useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const suiteDefaultsAppliedForSessionId = useRef<string | null>(null);
  const destinationDefaultAppliedForSessionId = useRef<string | null>(null);
  // New-suite-branch picker state. Only consulted when
  // `attachmentPickersEnabled` is true; defaults seeded from the project's
  // first standalone serverAttachment / `defaultHostId` (falling back to the
  // first project host), mirroring CreateSuiteDialog.
  const [createHostOpen, setCreateHostOpen] = useState(false);
  const [serverAttachmentId, setServerAttachmentId] = useState<string | null>(
    null
  );
  const [hostAttachments, setHostAttachments] = useState<HostAttachmentDraft[]>(
    []
  );

  const sessionServerDisplay = useMemo(
    () =>
      deriveSessionServerDisplay({
        usedServerRefs: detail.usedServerIds,
        selectedServers: detail.selectedServers,
        serversById,
        knownServerNames,
      }),
    [
      detail.selectedServers,
      detail.usedServerIds,
      knownServerNames,
      serversById,
    ]
  );
  const sessionServerLabels = useMemo(
    () => sessionServerDisplay.items.map((item) => item.label),
    [sessionServerDisplay.items]
  );

  const availableSuites = useMemo(
    () =>
      (suitesOverview ?? []).filter((entry) => entry.suite.source !== "sdk"),
    [suitesOverview]
  );

  const selectedSuiteEntry = useMemo(
    () =>
      availableSuites.find((entry) => entry.suite._id === selectedSuiteId) ??
      null,
    [availableSuites, selectedSuiteId]
  );
  const selectedSuiteServerDisplay = useMemo(() => {
    if (!selectedSuiteEntry) {
      return null;
    }

    return deriveSessionServerDisplay({
      usedServerRefs: normalizeServerNames(
        selectedSuiteEntry.suite.environment?.servers
      ),
      selectedServers: [],
      serversById,
      knownServerNames,
    });
  }, [knownServerNames, selectedSuiteEntry, serversById]);

  const missingServers = useMemo(() => {
    if (!selectedSuiteEntry) {
      return [];
    }
    // A loading race read as data: until `useProjectServers` answers,
    // `knownServerNames` is empty, so every session ref resolves to itself and
    // EVERY server looks missing. The chip row used to carry this flag; the
    // check needs it more, because a spurious "missing servers" blocks submit
    // behind an opt-in that patches a suite which was never short.
    if (projectServersLoading) {
      return [];
    }

    const suiteServerLabels = new Set(
      (selectedSuiteServerDisplay?.items ?? []).map((item) =>
        item.label.toLowerCase()
      )
    );

    return sessionServerDisplay.items
      .filter((item) => !suiteServerLabels.has(item.label.toLowerCase()))
      .map((item) => item.label);
  }, [
    selectedSuiteEntry,
    selectedSuiteServerDisplay,
    sessionServerDisplay.items,
    projectServersLoading,
  ]);
  /**
   * The standalone server group the suite pins, if any. When one is pinned,
   * the suite's runs resolve their servers from the GROUP: `startTestSuiteRun`
   * reads `standaloneAttachmentOverride` and bypasses per-host resolution.
   */
  const pinnedGroupServers = useMemo(
    () => selectedSuiteEntry?.suite.serverAttachment?.resolvedServerNames ?? [],
    [selectedSuiteEntry]
  );
  /**
   * Whether the suite pins a group AT ALL, which is a different question from
   * whether that group has servers in it. `resolveStandaloneSelection`
   * preserves a live-but-empty selection as `[]` rather than falling back to
   * the per-host pick — an empty group is still the active override, one that
   * says "no servers". Keying off the LENGTH read that as "no group pinned"
   * and offered the environment opt-in as though it could help.
   */
  const hasPinnedGroup = Boolean(selectedSuiteEntry?.suite.serverAttachment);

  /**
   * The selected suite's client · server, read-only — they belong to the
   * SUITE, not the case, so this branch reports the destination instead of
   * asking for it again (BB-93's "why do I see server selection twice?").
   */
  const selectedSuiteSummary = useMemo(() => {
    if (!selectedSuiteEntry) {
      return null;
    }

    const clients = (selectedSuiteEntry.suite.hostAttachments ?? [])
      .map((attachment) => attachment.hostName)
      .filter((hostName): hostName is string => Boolean(hostName?.trim()));
    // What the suite RUNS AGAINST, which for a suite pinning a standalone
    // server group is that group — not `environment.servers`, which a
    // group-backed suite leaves empty (`createTestSuite` stores
    // `args.environment?.servers ?? []`). Reading only the environment showed
    // "Claude" alone for every modern suite.
    //
    // DELIBERATELY a different source from `missingServers` below, which must
    // keep mirroring `environment.servers`: that is the list the backend gates
    // the import on and the one the opt-in patches. Pointing the check at the
    // group instead would have the client pass a suite the server then rejects
    // outright, replacing a fixable opt-in with a bare submit failure.
    const servers = hasPinnedGroup
      ? pinnedGroupServers
      : (selectedSuiteServerDisplay?.items ?? []).map((item) => item.label);

    const groups = [clients, servers]
      .filter((group) => group.length > 0)
      .map((group) => group.join(", "));

    return groups.length > 0 ? groups.join(" · ") : null;
  }, [pinnedGroupServers, selectedSuiteEntry, selectedSuiteServerDisplay]);

  /**
   * Session servers the promoted case will not actually reach. Separate from
   * `missingServers` because they mirror different lists: that one mirrors
   * `environment.servers`, which `importChatSessionToTestCase` gates on and
   * the opt-in patches, while this one mirrors the pinned group, which
   * `startTestSuiteRun` actually runs against. Conflating them let the opt-in
   * satisfy the gate and still import a case that runs without the server.
   */
  const unreachableServers = useMemo(() => {
    if (!selectedSuiteEntry || !hasPinnedGroup) {
      // No pinned group: run time and the gate read the same list, so
      // `missingServers` already covers it and the opt-in genuinely fixes it.
      return [];
    }
    const reachable = new Set(
      pinnedGroupServers.map((name) => name.trim().toLowerCase())
    );
    return sessionServerDisplay.items
      .filter((item) => !reachable.has(item.label.toLowerCase()))
      .map((item) => item.label);
  }, [pinnedGroupServers, selectedSuiteEntry, sessionServerDisplay.items]);

  const suiteChoiceAvailable = availableSuites.length > 0;
  // Guards the case where the mode outlives the suites it was picked for (a
  // reused dialog whose new session belongs to a project with none): the
  // existing branch is unreachable, so submit must not validate against it.
  const effectiveDestinationMode: DestinationMode = suiteChoiceAvailable
    ? destinationMode
    : "new";

  /** The one client the new-suite branch attaches; see `handleClientChange`. */
  const selectedHostId = hostAttachments[0]?.namedHostId ?? null;

  /**
   * Per-SESSION reset, keyed on `sessionId` rather than on the `summary`
   * object.
   *
   * Both adapters build `summary` with `useMemo` over Convex results, so its
   * identity changes when the promote detail lands and again on every later
   * subscription push. Depending on the object re-ran this on each of those
   * and wiped `selectedSuiteId` — which the seeding effect below then refuses
   * to restore, because its ref is already stamped for this session. The
   * pre-selected suite fell back to the placeholder with submit dead, and a
   * suite the user had picked by hand was silently reverted.
   *
   * Harmless before this PR, because nothing pre-selected a suite; the
   * seeding is what made the clear destructive.
   */
  const sessionId = summary?.sessionId ?? null;
  useEffect(() => {
    if (!open || !sessionId) {
      return;
    }

    setSelectedSuiteId("");
    setUpdateSuiteEnvironment(false);
    setContentTransferAcknowledged(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above: this
    // is deliberately keyed on the session, not on the summary object.
  }, [open, sessionId]);

  /**
   * Title seeding is separate, and also per-session: re-running it on every
   * `summary` push clobbered a title the user was part-way through typing.
   */
  const titleSeededForSessionId = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      titleSeededForSessionId.current = null;
      return;
    }
    if (!summary || titleSeededForSessionId.current === summary.sessionId) {
      return;
    }
    setCaseTitle(summary.title);
    titleSeededForSessionId.current = summary.sessionId;
  }, [open, summary]);

  /**
   * BB-163: "Existing suite (default if any exist)". The default cannot be a
   * `useState` initial value because the suite list arrives asynchronously —
   * seeding it here, once per session and only after the list resolves, is
   * what keeps a project WITH suites from opening on the new-suite branch and
   * silently creating a duplicate.
   *
   * Also pre-selects the first suite, so the destination is visible (with its
   * client · server underneath) rather than an empty picker above a disabled
   * button.
   */
  useEffect(() => {
    if (!open) {
      destinationDefaultAppliedForSessionId.current = null;
      return;
    }
    if (!summary || suitesPending) {
      return;
    }
    if (destinationDefaultAppliedForSessionId.current === summary.sessionId) {
      return;
    }

    if (availableSuites.length > 0) {
      setDestinationMode("existing");
      setSelectedSuiteId((current) => current || availableSuites[0].suite._id);
    } else {
      setDestinationMode("new");
    }
    destinationDefaultAppliedForSessionId.current = summary.sessionId;
  }, [open, summary, suitesPending, availableSuites]);

  useEffect(() => {
    if (!open) {
      setUpdateSuiteEnvironment(false);
      setContentTransferAcknowledged(false);
      setIsSubmitting(false);
      setServerAttachmentId(null);
      setHostAttachments([]);
    }
  }, [open]);

  // Seed picker defaults when the dialog opens against a project that has
  // attachments/hosts available. Mirrors CreateSuiteDialog: pick the first
  // standalone serverAttachment; hosts prefer `defaultHostId` when it names
  // a live project host. User can swap either via the picker (Create new is
  // supported inline by both editors).
  useEffect(() => {
    if (!attachmentPickersEnabled) return;
    if (serverAttachmentId === null && projectServerAttachments.length > 0) {
      setServerAttachmentId(projectServerAttachments[0]._id);
    }
  }, [attachmentPickersEnabled, projectServerAttachments, serverAttachmentId]);

  useEffect(() => {
    if (!attachmentPickersEnabled) return;
    if (!hostDefaultResolved) return;
    // Don't seed while the adapter is still resolving detail: project hosts
    // are often already cached, so seeding here would grab projectHosts[0]
    // and the non-empty attachment would then block the reseed once the
    // authoritative `defaultHostId` arrives — silently attaching the wrong
    // host. A user edit before load completes still wins (non-empty guard).
    if (detail.loading) return;
    if (hostAttachments.length === 0 && projectHosts.length > 0) {
      const preferredHostId =
        defaultHostId &&
        projectHosts.some((host) => host.hostId === defaultHostId)
          ? defaultHostId
          : projectHosts[0].hostId;
      setHostAttachments([
        {
          namedHostId: preferredHostId,
          enabledOptionalServerIds: [],
        },
      ]);
    }
  }, [
    attachmentPickersEnabled,
    defaultHostId,
    detail.loading,
    hostAttachments.length,
    hostDefaultResolved,
    projectHosts,
  ]);

  useEffect(() => {
    if (!open) {
      suiteDefaultsAppliedForSessionId.current = null;
      return;
    }
    if (!summary) {
      return;
    }
    if (detail.loading) {
      return;
    }
    if (suiteDefaultsAppliedForSessionId.current === summary.sessionId) {
      return;
    }

    setNewSuiteName(
      buildServerBasedSuiteName(sessionServerLabels, `${summary.title} suite`)
    );
    suiteDefaultsAppliedForSessionId.current = summary.sessionId;
  }, [open, summary, detail.loading, sessionServerLabels]);

  // New-suite branch + attachment pickers visible: require both a server
  // attachment and at least one host (parity with CreateSuiteDialog —
  // otherwise the created suite lands in the same broken state the
  // pickers were added to prevent).
  const newSuiteRequirementsMet =
    !attachmentPickersEnabled ||
    (serverAttachmentId !== null && hostAttachments.length > 0);

  const canSubmit =
    Boolean(summary) &&
    Boolean(effectiveProjectId) &&
    // The acknowledgement is a REQUIRED input, not a nudge: an unticked box
    // disables submit rather than showing a warning someone can push past.
    (detail.requiresContentTransferAcknowledgement !== true ||
      contentTransferAcknowledged) &&
    !attachmentPickersPending &&
    !detail.loading &&
    !detail.error &&
    // The branch itself is still unknown until the suite list lands, so there
    // is nothing coherent to validate yet.
    !suitesPending &&
    caseTitle.trim().length > 0 &&
    !isSubmitting &&
    (effectiveDestinationMode === "new"
      ? newSuiteName.trim().length > 0 && newSuiteRequirementsMet
      : Boolean(selectedSuiteId) &&
        (missingServers.length === 0 || updateSuiteEnvironment));

  const requiresContentTransferAck =
    detail.requiresContentTransferAcknowledgement === true;

  const handleSubmit = async () => {
    if (!summary || !effectiveProjectId || !canSubmit) {
      return;
    }

    setIsSubmitting(true);
    try {
      const result = (await importChatSession({
        sessionId: summary.sessionId,
        projectId: effectiveProjectId,
        ...(effectiveDestinationMode === "existing"
          ? {
              destinationSuiteId: selectedSuiteId,
              updateSuiteEnvironment,
            }
          : {
              newSuiteName: newSuiteName.trim(),
              // Forward picker selections so the new suite lands fully
              // configured (matches `createTestSuite`'s wiring). Omitted
              // when pickers are disabled — backend keeps the legacy path.
              ...(attachmentPickersEnabled && serverAttachmentId
                ? { newSuiteServerAttachmentId: serverAttachmentId }
                : {}),
              ...(attachmentPickersEnabled && hostAttachments.length > 0
                ? { newSuiteHostAttachments: hostAttachments }
                : {}),
            }),
        testCaseTitle: caseTitle.trim(),
        // Sent ONLY when it was actually asked for and ticked. Sending `true`
        // unconditionally would stamp an audit record saying a person decided
        // something they were never shown.
        ...(requiresContentTransferAck && contentTransferAcknowledged
          ? { contentTransferAcknowledged: true }
          : {}),
      })) as {
        suiteId: string;
        testCaseId: string;
        createdSuite?: boolean;
        updatedSuiteEnvironment?: boolean;
        addedServers?: string[];
      };

      const added = result.addedServers ?? [];
      if (
        effectiveDestinationMode === "existing" &&
        result.updatedSuiteEnvironment === true &&
        added.length > 0
      ) {
        toast.success(
          `Session promoted to a test case. Added ${added.join(
            ", "
          )} to the suite.`
        );
      } else {
        toast.success("Session promoted to a test case");
      }
      onOpenChange(false);
      onImported({ suiteId: result.suiteId, testCaseId: result.testCaseId });
    } catch (error) {
      toast.error(getBillingErrorMessage(error, "Failed to promote session"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const sessionTitle = summary?.title ?? "Imported chat";

  /**
   * One client, chosen in one field. The wire shape stays the backend's
   * attachment array so the created suite can grow more clients later in
   * suite settings — but promoting does not make you assemble a fan-out.
   */
  const handleClientChange = (hostId: string | null) => {
    setHostAttachments(
      hostId ? [{ namedHostId: hostId, enabledOptionalServerIds: [] }] : []
    );
  };

  /**
   * A promote that cannot happen at all. These REPLACE the form rather than
   * sitting above a set of fields nobody can submit: neither a session the
   * backend refuses nor a project-less session has a destination to pick.
   */
  const blockingNotice = detail.error ? (
    <Alert variant="destructive">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Import unavailable</AlertTitle>
      <AlertDescription>{detail.error}</AlertDescription>
    </Alert>
  ) : !effectiveProjectId ? (
    <Alert variant="destructive">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Import unavailable</AlertTitle>
      <AlertDescription>
        This session is not linked to a shared project yet, so it cannot be
        promoted to a suite-backed test case.
      </AlertDescription>
    </Alert>
  ) : null;

  const existingSuiteFields = (
    <>
      <div className="space-y-2">
        <Label htmlFor="promote-existing-suite">Suite</Label>
        <Select
          value={selectedSuiteId}
          onValueChange={(next) => {
            setSelectedSuiteId(next);
            // The opt-in below records a decision about ONE suite's
            // environment. Carrying a tick from suite A into suite B would
            // let a submit patch B on the strength of a confirmation the
            // user never gave for it.
            setUpdateSuiteEnvironment(false);
          }}
          disabled={isSubmitting}
        >
          <SelectTrigger id="promote-existing-suite" className="w-full">
            <SelectValue placeholder="Choose a suite" />
          </SelectTrigger>
          <SelectContent>
            {availableSuites.map((entry) => (
              <SelectItem key={entry.suite._id} value={entry.suite._id}>
                {entry.suite.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Read-only, because client and server are the suite's, not this
          case's. Shown rather than re-asked so the destination is still
          verifiable at a glance. */}
      {selectedSuiteEntry ? (
        <p
          className="text-[13px] leading-[18px] text-muted-foreground"
          data-testid="promote-existing-suite-summary"
        >
          {selectedSuiteSummary ?? "No client or server attached yet."}
        </p>
      ) : null}

      {/* A pinned server group is FROZEN by design — "to change the
          selection, create a new attachment and re-point the suite" — so
          nothing this dialog can offer will add a server to it, and the
          opt-in below patches a list the runner does not read. Say that
          plainly instead of collecting a confirmation that changes nothing. */}
      {selectedSuiteEntry && unreachableServers.length > 0 ? (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>The suite&apos;s server group is missing servers</AlertTitle>
          <AlertDescription>
            This suite runs against a fixed server group, which does not
            include {unreachableServers.join(", ")}. The case will still be
            created, but it will run without{" "}
            {unreachableServers.length === 1 ? "that server" : "those servers"}
            {" "}until the group is updated in suite settings.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Not in the design because it is not in the happy path: the session
          used a server the suite does not have, and importing without it
          would produce a case that cannot run. Kept as a submit-blocking
          opt-in — the alternative is a green button that writes a broken
          case. */}
      {selectedSuiteEntry && missingServers.length > 0 ? (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Suite environment update required</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              The selected suite&apos;s recorded environment is missing these
              servers: {missingServers.join(", ")}.
            </p>
            {/* `deriveSessionServerDisplay` falls back to the raw ref when it
                cannot match a current project server, so this list can be
                Convex ids. The chip row used to explain that; without a note
                the user is blocked by a string with no meaning. */}
            {sessionServerDisplay.unresolvedCount > 0 ? (
              <p className="text-xs leading-relaxed">
                Some of those could not be matched to a current project server,
                so their stored ids are shown.
              </p>
            ) : null}
            <label className="flex items-start gap-3">
              <Checkbox
                checked={updateSuiteEnvironment}
                onCheckedChange={(checked) =>
                  setUpdateSuiteEnvironment(checked === true)
                }
                disabled={isSubmitting}
                className="mt-0.5"
              />
              <span className="text-sm">
                {hasPinnedGroup
                  ? "Record these servers on the suite so the import can proceed."
                  : "Add the missing servers to this suite before importing the case."}
              </span>
            </label>
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );

  const newSuiteFields = (
    <>
      <div className="space-y-2">
        <Label htmlFor="promote-new-suite-name">Suite name</Label>
        <Input
          id="promote-new-suite-name"
          value={newSuiteName}
          onChange={(event) => setNewSuiteName(event.target.value)}
          placeholder="Imported suite"
          disabled={isSubmitting}
        />
      </div>

      {/* Side by side, and only on this branch: a new suite is the one case
          where nobody has decided what it runs against yet. Both are
          pre-filled from the session, so the common path is to read them
          rather than answer them. */}
      {attachmentPickersEnabled && effectiveProjectId ? (
        <div className="grid grid-cols-2 gap-3">
          <div className="min-w-0 space-y-2">
            <Label htmlFor="promote-new-suite-client">Client</Label>
            <HostPicker
              projectId={effectiveProjectId}
              value={selectedHostId}
              onChange={handleClientChange}
              location="eval_runner"
              placeholder="Select a client"
              includeNone={false}
              disabled={isSubmitting}
              priorityHostId={defaultHostId ?? undefined}
              triggerId="promote-new-suite-client"
              // `SelectTrigger` is `w-fit`; without this the Client control
              // shrinks to its content while Server fills its grid cell.
              triggerClassName="w-full"
            />
            {/* A project with no clients is otherwise a dead end: the seeding
                effect needs `projectHosts.length > 0`, so `hostAttachments`
                stays empty, `newSuiteRequirementsMet` is false, and submit is
                dead behind an empty dropdown that explains nothing. The editor
                this replaced carried both an empty state and an inline create;
                `ServerGroupPicker` still does, so the asymmetry was an
                oversight, not a decision. */}
            {projectHosts.length === 0 ? (
              <div className="space-y-1.5">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  This project has no clients yet. A new suite needs one to run
                  against.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setCreateHostOpen(true)}
                  disabled={isSubmitting}
                  data-testid="promote-create-client"
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Create a client
                </Button>
              </div>
            ) : null}
          </div>
          <div className="min-w-0 space-y-2">
            <Label htmlFor="promote-new-suite-server">Server</Label>
            <ServerAttachmentPicker
              projectId={effectiveProjectId}
              value={serverAttachmentId}
              onChange={setServerAttachmentId}
              onClearSelection={() => setServerAttachmentId(null)}
              disabled={isSubmitting}
              variant="field"
              emptyTriggerLabel="Select a server group"
              triggerId="promote-new-suite-server"
              triggerTestId="promote-new-suite-server-trigger"
              // The dialog's scroll-lock blocks the wheel on portaled
              // content, so the group list has to render in place.
              inModal
            />
          </div>
        </div>
      ) : null}

      {/* Attaches the freshly created client straight away, so the create ends
          in a filled field rather than back at the empty dropdown. */}
      {effectiveProjectId ? (
        <CreateHostDialog
          isOpen={createHostOpen}
          onClose={() => setCreateHostOpen(false)}
          projectId={effectiveProjectId}
          onCreated={(hostId) => handleClientChange(hostId)}
        />
      ) : null}
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 sm:max-w-xl border-border/50 p-0 shadow-sm">
        <div className="px-6 pt-6">
          <DialogHeader className="space-y-1.5 pr-10">
            <DialogTitle>Promote to test case</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              Turn this session into a reusable case.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="space-y-5 px-6 py-5">
          {blockingNotice ?? (
            <>
              <div className="space-y-2">
                <Label htmlFor="promote-test-case-name">Test case name</Label>
                <Input
                  id="promote-test-case-name"
                  value={caseTitle}
                  onChange={(event) => setCaseTitle(event.target.value)}
                  placeholder={sessionTitle}
                  disabled={isSubmitting}
                />
              </div>

              {detail.loading || suitesPending ? (
                <div className="flex min-h-10 items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                  {/* Two different waits, and this branch hides "Add to"
                      either way — one message left the user unable to tell
                      "this project has no suites" from "the list hasn't
                      arrived yet". */}
                  {detail.loading
                    ? "Loading session details…"
                    : "Loading this project's suites…"}
                </div>
              ) : suiteChoiceAvailable ? (
                <div className="space-y-3">
                  <p className="text-sm font-medium text-foreground">Add to</p>
                  <RadioGroup
                    value={effectiveDestinationMode}
                    onValueChange={(next) =>
                      setDestinationMode(next as DestinationMode)
                    }
                    aria-label="Add to"
                    className="gap-2"
                  >
                    <DestinationCard
                      value="existing"
                      title="Existing suite"
                      selected={effectiveDestinationMode === "existing"}
                      disabled={isSubmitting}
                    >
                      {existingSuiteFields}
                    </DestinationCard>
                    <DestinationCard
                      value="new"
                      title="New suite"
                      selected={effectiveDestinationMode === "new"}
                      disabled={isSubmitting}
                    >
                      {newSuiteFields}
                    </DestinationCard>
                  </RadioGroup>
                </div>
              ) : (
                // No suites to choose between, so there is no question to
                // ask: show the new-suite fields directly. Explicitly NOT a
                // nested create-suite modal, and not a radio group with one
                // answer.
                <div className="space-y-3">{newSuiteFields}</div>
              )}

            {requiresContentTransferAck ? (
              <div>
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Someone else wrote this transcript</AlertTitle>
                  <AlertDescription className="space-y-3">
                    <p id="content-transfer-consequence">
                      This is a real User Testing session. Promoting it copies a
                      tester&apos;s own words into a test case your project keeps
                      — outside the User Testing surface they were written on.
                    </p>
                    {/* A real `<label htmlFor>` bound to the checkbox's own
                        id, so the whole sentence is the hit target and the
                        control is reachable by keyboard alone.
                        `aria-describedby` points at the consequence, which is
                        the part worth hearing before the box is ticked. */}
                    <label
                      className="flex items-start gap-3"
                      htmlFor="content-transfer-ack"
                    >
                      <Checkbox
                        id="content-transfer-ack"
                        checked={contentTransferAcknowledged}
                        onCheckedChange={(checked) =>
                          setContentTransferAcknowledged(checked === true)
                        }
                        aria-describedby="content-transfer-consequence"
                        disabled={isSubmitting}
                        className="mt-0.5"
                      />
                      <span className="text-sm">
                        I understand this copies a tester&apos;s content into a
                        durable test case.
                      </span>
                    </label>
                  </AlertDescription>
                </Alert>
              </div>
            ) : null}
            </>
          )}
        </div>

        <DialogFooter className="border-t border-border/50 px-6 py-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
          >
            {isSubmitting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            Promote to test case
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
