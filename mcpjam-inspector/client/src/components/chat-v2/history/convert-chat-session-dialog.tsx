import { useAction, useConvexAuth, useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { toast } from "sonner";
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
import { Alert, AlertDescription, AlertTitle } from "@mcpjam/design-system/alert";
import {
  getChatHistoryDetail,
  type ChatHistorySession,
} from "@/lib/apis/web/chat-history-api";
import type { EvalSuiteOverviewEntry } from "@/components/evals/types";
import {
  buildServerBasedSuiteName,
  normalizeServerNames,
} from "@/components/evals/suite-environment-utils";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { useProjectServerAttachments, useProjectServers } from "@/hooks/useViews";
import { useHostList } from "@/hooks/useClients";
import {
  ClientAttachmentsEditor,
  type HostAttachmentDraft,
} from "@/components/evals/client-attachments-editor";
import { ServerAttachmentPicker } from "@/components/evals/server-attachment-picker";
import { deriveSessionServerDisplay } from "./session-server-display";
import { cn } from "@/lib/utils";

type ConvertChatSessionDialogProps = {
  open: boolean;
  session: ChatHistorySession | null;
  isAuthenticated: boolean;
  projectId: string | null;
  requestHeaders?: HeadersInit;
  onOpenChange: (open: boolean) => void;
  onImported: (result: { suiteId: string; testCaseId: string }) => void;
};

type DestinationMode = "existing" | "new";

function getSessionTitle(session: ChatHistorySession | null): string {
  if (!session) {
    return "Imported chat";
  }
  return (
    session.customTitle ||
    session.firstMessagePreview.slice(0, 60) ||
    "Imported chat"
  );
}

export function ConvertChatSessionDialog({
  open,
  session,
  isAuthenticated,
  projectId,
  requestHeaders,
  onOpenChange,
  onImported,
}: ConvertChatSessionDialogProps) {
  const effectiveProjectId = session?.projectId ?? projectId ?? null;
  // Mirror Create suite's `hostsEnabled` gate: the server/host attachment
  // pickers (and the new-suite branch's serverAttachmentId/hostAttachments
  // wiring) only apply in the unified-attachment world. Without the flag,
  // we preserve the legacy path that #395 already covers.
  const hostsFlagEnabled = useFeatureFlagEnabled("hosts-enabled");
  const { isAuthenticated: convexAuthed } = useConvexAuth();
  const attachmentPickersEnabled =
    hostsFlagEnabled === true && convexAuthed && Boolean(effectiveProjectId);
  const { servers, serversById, isLoading: projectServersLoading } =
    useProjectServers({
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
    [servers],
  );
  const suitesOverview = useQuery(
    "testSuites:getTestSuitesOverview" as any,
    open && effectiveProjectId
      ? ({ projectId: effectiveProjectId } as any)
      : "skip",
  ) as EvalSuiteOverviewEntry[] | undefined;
  const importChatSession = useAction(
    "testSuites:importChatSessionToTestCase" as any,
  );

  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [caseTitle, setCaseTitle] = useState("");
  const [destinationMode, setDestinationMode] =
    useState<DestinationMode>("new");
  const [selectedSuiteId, setSelectedSuiteId] = useState<string>("");
  const [newSuiteName, setNewSuiteName] = useState("");
  const [rawSelectedServers, setRawSelectedServers] = useState<string[]>([]);
  const [usedServerRefs, setUsedServerRefs] = useState<string[]>([]);
  const [updateSuiteEnvironment, setUpdateSuiteEnvironment] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const suiteDefaultsAppliedForSessionId = useRef<string | null>(null);
  // New-suite-branch picker state. Only consulted when
  // `attachmentPickersEnabled` is true; defaults seeded from the project's
  // first standalone serverAttachment / first project host, mirroring
  // CreateSuiteDialog.
  const [serverAttachmentId, setServerAttachmentId] = useState<string | null>(
    null,
  );
  const [hostAttachments, setHostAttachments] = useState<HostAttachmentDraft[]>(
    [],
  );

  const sessionServerDisplay = useMemo(
    () =>
      deriveSessionServerDisplay({
        usedServerRefs,
        selectedServers: rawSelectedServers,
        serversById,
        knownServerNames,
      }),
    [knownServerNames, rawSelectedServers, serversById, usedServerRefs],
  );
  const sessionServerLabels = useMemo(
    () => sessionServerDisplay.items.map((item) => item.label),
    [sessionServerDisplay.items],
  );

  const availableSuites = useMemo(
    () =>
      (suitesOverview ?? []).filter((entry) => entry.suite.source !== "sdk"),
    [suitesOverview],
  );

  const selectedSuiteEntry = useMemo(
    () =>
      availableSuites.find((entry) => entry.suite._id === selectedSuiteId) ??
      null,
    [availableSuites, selectedSuiteId],
  );
  const selectedSuiteServerDisplay = useMemo(() => {
    if (!selectedSuiteEntry) {
      return null;
    }

    return deriveSessionServerDisplay({
      usedServerRefs: normalizeServerNames(
        selectedSuiteEntry.suite.environment?.servers,
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

    const suiteServerLabels = new Set(
      (selectedSuiteServerDisplay?.items ?? []).map((item) =>
        item.label.toLowerCase(),
      ),
    );

    return sessionServerDisplay.items
      .filter((item) => !suiteServerLabels.has(item.label.toLowerCase()))
      .map((item) => item.label);
  }, [selectedSuiteEntry, selectedSuiteServerDisplay, sessionServerDisplay.items]);
  const sessionServersDescription =
    sessionServerDisplay.source === "used"
      ? "Derived from stored tool activity in this chat session."
      : sessionServerDisplay.source === "selected"
        ? "Falls back to this chat session's stored server selection."
        : "Uses stored session metadata when server activity is available.";

  useEffect(() => {
    if (!open || !session) {
      return;
    }

    const title = getSessionTitle(session);
    setCaseTitle(title);
    setDestinationMode("new");
    setSelectedSuiteId("");
    setUpdateSuiteEnvironment(false);
    setDetailLoading(true);
    setDetailError(null);

    let cancelled = false;

    void (async () => {
      try {
        const detail = await getChatHistoryDetail(
          {
            sessionId: session._id,
            chatSessionId: session.chatSessionId,
            projectId: effectiveProjectId ?? undefined,
          },
          {
            headers: requestHeaders,
          },
        );
        if (cancelled) {
          return;
        }

        const selectedServers = normalizeServerNames(
          detail.session.resumeConfig?.selectedServers,
        );
        const usedServerIds = normalizeServerNames(detail.session.usedServerIds);
        setRawSelectedServers(selectedServers);
        setUsedServerRefs(usedServerIds);
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message =
          error instanceof Error ? error.message : "Failed to load chat session";
        setDetailError(message);
      } finally {
        if (!cancelled) {
          setDetailLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [effectiveProjectId, open, requestHeaders, session]);

  useEffect(() => {
    if (!open) {
      setDetailError(null);
      setRawSelectedServers([]);
      setUsedServerRefs([]);
      setUpdateSuiteEnvironment(false);
      setIsSubmitting(false);
      setServerAttachmentId(null);
      setHostAttachments([]);
    }
  }, [open]);

  // Seed picker defaults when the dialog opens against a project that has
  // attachments/hosts available. Mirrors CreateSuiteDialog: pick the first
  // standalone serverAttachment and the first project host. User can swap
  // either via the picker (Create new is supported inline by both editors).
  useEffect(() => {
    if (!attachmentPickersEnabled) return;
    if (serverAttachmentId === null && projectServerAttachments.length > 0) {
      setServerAttachmentId(projectServerAttachments[0]._id);
    }
  }, [attachmentPickersEnabled, projectServerAttachments, serverAttachmentId]);

  useEffect(() => {
    if (!attachmentPickersEnabled) return;
    if (hostAttachments.length === 0 && projectHosts.length > 0) {
      setHostAttachments([
        {
          namedHostId: projectHosts[0].hostId,
          enabledOptionalServerIds: [],
        },
      ]);
    }
  }, [attachmentPickersEnabled, hostAttachments.length, projectHosts]);

  useEffect(() => {
    if (!open) {
      suiteDefaultsAppliedForSessionId.current = null;
      return;
    }
    if (!session) {
      return;
    }
    if (detailLoading) {
      return;
    }
    if (suiteDefaultsAppliedForSessionId.current === session._id) {
      return;
    }

    const title = getSessionTitle(session);
    setNewSuiteName(
      buildServerBasedSuiteName(sessionServerLabels, `${title} suite`),
    );
    suiteDefaultsAppliedForSessionId.current = session._id;
  }, [
    open,
    session,
    detailLoading,
    sessionServerLabels,
  ]);

  // New-suite branch + attachment pickers visible: require both a server
  // attachment and at least one host (parity with CreateSuiteDialog —
  // otherwise the created suite lands in the same broken state the
  // pickers were added to prevent).
  const newSuiteRequirementsMet =
    !attachmentPickersEnabled ||
    (serverAttachmentId !== null && hostAttachments.length > 0);

  const canSubmit =
    Boolean(session) &&
    Boolean(effectiveProjectId) &&
    !detailLoading &&
    !detailError &&
    caseTitle.trim().length > 0 &&
    !isSubmitting &&
    (destinationMode === "new"
      ? newSuiteName.trim().length > 0 && newSuiteRequirementsMet
      : Boolean(selectedSuiteId) &&
        (missingServers.length === 0 || updateSuiteEnvironment));

  const handleSubmit = async () => {
    if (!session || !effectiveProjectId || !canSubmit) {
      return;
    }

    setIsSubmitting(true);
    try {
      const result = (await importChatSession({
        sessionId: session._id,
        projectId: effectiveProjectId,
        ...(destinationMode === "existing"
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
      })) as {
        suiteId: string;
        testCaseId: string;
        createdSuite?: boolean;
        updatedSuiteEnvironment?: boolean;
        addedServers?: string[];
      };

      const added = result.addedServers ?? [];
      if (
        destinationMode === "existing" &&
        result.updatedSuiteEnvironment === true &&
        added.length > 0
      ) {
        toast.success(
          `Chat session promoted to a test case. Added ${added.join(", ")} to the suite.`,
        );
      } else {
        toast.success("Chat session promoted to a test case");
      }
      onOpenChange(false);
      onImported({ suiteId: result.suiteId, testCaseId: result.testCaseId });
    } catch (error) {
      toast.error(
        getBillingErrorMessage(error, "Failed to promote chat session"),
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const sessionTitle = getSessionTitle(session);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 sm:max-w-xl border-border/50 p-0 shadow-sm">
        <div className="px-6 pt-6">
          <DialogHeader className="space-y-1.5 pr-10">
            <DialogTitle>Promote to test case</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              Create a suite-backed test case from this chat session. The full
              session is compiled into multi-turn prompt turns.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="space-y-6 px-6 py-5">
          <div className="space-y-2">
            <Label htmlFor="chat-import-case-title">Case title</Label>
            <Input
              id="chat-import-case-title"
              value={caseTitle}
              onChange={(event) => setCaseTitle(event.target.value)}
              placeholder={sessionTitle}
            />
          </div>

          <div className="space-y-2">
            <div className="space-y-0.5">
              <p className="text-sm font-medium text-foreground">Session servers</p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {sessionServersDescription}
              </p>
            </div>
            {detailLoading ? (
              <div className="flex min-h-10 items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                Loading chat session details…
              </div>
            ) : detailError ? (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Import unavailable</AlertTitle>
                <AlertDescription>{detailError}</AlertDescription>
              </Alert>
            ) : !effectiveProjectId ? (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Import unavailable</AlertTitle>
                <AlertDescription>
                  This chat session is not linked to a shared project yet, so
                  it cannot be promoted to a suite-backed test case.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="space-y-2">
                <div className="flex min-h-10 flex-wrap content-center gap-1.5">
                  {sessionServerDisplay.items.length > 0 ? (
                    sessionServerDisplay.items.map((server) => (
                      <span
                        key={`${server.raw}:${server.label}`}
                        className={cn(
                          "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium",
                          server.unresolved
                            ? "border-dashed border-border/50 bg-transparent font-mono text-muted-foreground"
                            : "border-border/50 bg-muted/50 text-foreground",
                        )}
                      >
                        {server.label}
                      </span>
                    ))
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      No servers were recorded for this session.
                    </span>
                  )}
                </div>
                {!projectServersLoading &&
                sessionServerDisplay.unresolvedCount > 0 ? (
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Some servers could not be resolved to current project
                    names, so raw ids are shown.
                  </p>
                ) : null}
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div className="space-y-0.5">
              <p className="text-sm font-medium text-foreground">Destination suite</p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Create a new suite or add the case to an existing one.
              </p>
            </div>

            <div
              className="flex rounded-lg border border-border/50 bg-muted/30 p-1"
              role="group"
              aria-label="Destination suite"
            >
              <Button
                type="button"
                variant="ghost"
                className={cn(
                  "h-8 flex-1 rounded-md text-sm font-medium shadow-none",
                  destinationMode === "new"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-transparent hover:text-foreground",
                )}
                onClick={() => setDestinationMode("new")}
              >
                Create new suite
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={availableSuites.length === 0}
                className={cn(
                  "h-8 flex-1 rounded-md text-sm font-medium shadow-none",
                  destinationMode === "existing"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-transparent hover:text-foreground",
                )}
                onClick={() => setDestinationMode("existing")}
              >
                Use existing suite
              </Button>
            </div>

            {destinationMode === "new" ? (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="chat-import-suite-name">Suite name</Label>
                  <Input
                    id="chat-import-suite-name"
                    value={newSuiteName}
                    onChange={(event) => setNewSuiteName(event.target.value)}
                    placeholder="Imported suite"
                  />
                </div>

                {attachmentPickersEnabled && effectiveProjectId ? (
                  <div className="divide-y rounded-lg border bg-muted/20">
                    <div className="flex items-start justify-between gap-4 p-3">
                      <div className="min-w-0 space-y-0.5">
                        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Servers
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          Server set all clients run against.
                        </p>
                      </div>
                      <div className="shrink-0">
                        <ServerAttachmentPicker
                          projectId={effectiveProjectId}
                          value={serverAttachmentId}
                          onChange={setServerAttachmentId}
                          disabled={isSubmitting}
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
                        projectId={effectiveProjectId}
                        value={hostAttachments}
                        onChange={setHostAttachments}
                        disabled={isSubmitting}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="chat-import-existing-suite">Existing suite</Label>
                  <Select
                    value={selectedSuiteId}
                    onValueChange={setSelectedSuiteId}
                  >
                    <SelectTrigger id="chat-import-existing-suite">
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

                {selectedSuiteEntry && missingServers.length > 0 ? (
                  <Alert>
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>Suite environment update required</AlertTitle>
                    <AlertDescription className="space-y-3">
                      <p>
                        The selected suite is missing these servers:{" "}
                        {missingServers.join(", ")}.
                      </p>
                      <label className="flex items-start gap-3">
                        <Checkbox
                          checked={updateSuiteEnvironment}
                          onCheckedChange={(checked) =>
                            setUpdateSuiteEnvironment(checked === true)
                          }
                          className="mt-0.5"
                        />
                        <span className="text-sm">
                          Add the missing servers to this suite before importing
                          the case.
                        </span>
                      </label>
                    </AlertDescription>
                  </Alert>
                ) : null}
              </div>
            )}
          </div>
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
          <Button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Promote to test case
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
