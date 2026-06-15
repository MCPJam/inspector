import { useAction, useConvexAuth, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { FlaskConical, Loader2 } from "lucide-react";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import type { EvalSuiteOverviewEntry } from "@/components/evals/types";
import { useProjectServerAttachments } from "@/hooks/useViews";
import { useHostList } from "@/hooks/useClients";
import {
  ClientAttachmentsEditor,
  type HostAttachmentDraft,
} from "@/components/evals/client-attachments-editor";
import { ServerAttachmentPicker } from "@/components/evals/server-attachment-picker";

type SaveAsTestCaseActionProps = {
  /**
   * Client-generated chat session id (the `chatSessionId` string, not the
   * Convex `_id`). Always available in the inspector regardless of
   * HOSTED_MODE / history-rail state.
   */
  chatSessionId: string;
  /**
   * Zero-based ordinal of this user message among `role: "user"` messages
   * in the chat — matches the `promptIndex` recorded on
   * `chatSessionTurnTraces` / `testCase.promptIndex` and is what the
   * backend uses to anchor a turn inside the persisted transcript blob
   * (which carries no per-message ids).
   */
  promptIndex: number;
  /** Used to seed the test-case title; not sent to the server. */
  promptPreview?: string;
  /** Required to fetch suites and create a new suite when needed. */
  projectId: string | null;
};

type DestinationMode = "existing" | "new";

/**
 * Per-user-message overflow action that promotes a single chat turn into a
 * test case. The backend rejects turns with no observed tool calls; create
 * a negative test directly from the Evals suite when one is needed.
 */
export function SaveAsTestCaseAction({
  chatSessionId,
  promptIndex,
  promptPreview,
  projectId,
}: SaveAsTestCaseActionProps) {
  const evaluateUiEnabled = useFeatureFlagEnabled("evaluate-ui");
  const hostsFlagEnabled = useFeatureFlagEnabled("hosts-enabled");
  const { isAuthenticated: convexAuthed } = useConvexAuth();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [caseTitle, setCaseTitle] = useState(() =>
    seedTitleFromPrompt(promptPreview),
  );
  const [destinationMode, setDestinationMode] =
    useState<DestinationMode>("existing");
  const [selectedSuiteId, setSelectedSuiteId] = useState<string>("");
  const [newSuiteName, setNewSuiteName] = useState<string>("");
  // Picker state for the new-suite branch. Mirrors CreateSuiteDialog and
  // ConvertChatSessionDialog. Gated on `attachmentPickersEnabled`.
  const [serverAttachmentId, setServerAttachmentId] = useState<string | null>(
    null,
  );
  const [hostAttachments, setHostAttachments] = useState<HostAttachmentDraft[]>(
    [],
  );

  // Intentionally tied to the raw PostHog flag, not the desktop-default-on
  // helper: `attachmentPickersEnabled` also gates the "new suite requires
  // both a server and a host attachment" requirement (see
  // `newSuiteRequirementsMet` below). Flipping it on for desktop blocks the
  // empty-skeleton-then-attach-later flow.
  const attachmentPickersEnabled =
    hostsFlagEnabled === true && convexAuthed && Boolean(projectId);

  const { serverAttachments: projectServerAttachments } =
    useProjectServerAttachments({
      isAuthenticated: open && attachmentPickersEnabled,
      projectId: open && attachmentPickersEnabled ? projectId : null,
    });
  const { hosts: projectHosts } = useHostList({
    isAuthenticated: open && attachmentPickersEnabled,
    projectId: open && attachmentPickersEnabled ? projectId : null,
  });

  const suitesOverview = useQuery(
    "testSuites:getTestSuitesOverview" as any,
    open && projectId ? ({ projectId } as any) : "skip",
  ) as EvalSuiteOverviewEntry[] | undefined;

  const saveAsTestCase = useAction(
    "testSuites:saveAsTestCaseFromChatMessage" as any,
  );

  useEffect(() => {
    if (!open || !attachmentPickersEnabled) return;
    if (serverAttachmentId === null && projectServerAttachments.length > 0) {
      setServerAttachmentId(projectServerAttachments[0]._id);
    }
  }, [
    open,
    attachmentPickersEnabled,
    projectServerAttachments,
    serverAttachmentId,
  ]);

  useEffect(() => {
    if (!open || !attachmentPickersEnabled) return;
    if (hostAttachments.length === 0 && projectHosts.length > 0) {
      setHostAttachments([
        {
          namedHostId: projectHosts[0].hostId,
          enabledOptionalServerIds: [],
        },
      ]);
    }
  }, [open, attachmentPickersEnabled, hostAttachments.length, projectHosts]);

  const availableSuites = useMemo(
    () =>
      (suitesOverview ?? []).filter((entry) => entry.suite.source !== "sdk"),
    [suitesOverview],
  );

  const newSuiteRequirementsMet =
    !attachmentPickersEnabled ||
    (serverAttachmentId !== null && hostAttachments.length > 0);

  const canSubmit =
    !submitting &&
    caseTitle.trim().length > 0 &&
    (destinationMode === "existing"
      ? Boolean(selectedSuiteId)
      : newSuiteName.trim().length > 0 && newSuiteRequirementsMet);

  const handleOpenChange = (next: boolean) => {
    if (submitting) return;
    setOpen(next);
    if (!next) {
      setCaseTitle(seedTitleFromPrompt(promptPreview));
      setSelectedSuiteId("");
      setNewSuiteName("");
      setDestinationMode("existing");
      setServerAttachmentId(null);
      setHostAttachments([]);
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit || !projectId) {
      return;
    }
    setSubmitting(true);
    try {
      const result = (await saveAsTestCase({
        chatSessionId,
        promptIndex,
        projectId,
        testCaseTitle: caseTitle.trim(),
        updateSuiteEnvironment: true,
        ...(destinationMode === "existing"
          ? { destinationSuiteId: selectedSuiteId }
          : {
              newSuiteName: newSuiteName.trim(),
              ...(attachmentPickersEnabled && serverAttachmentId
                ? { newSuiteServerAttachmentId: serverAttachmentId }
                : {}),
              ...(attachmentPickersEnabled && hostAttachments.length > 0
                ? { newSuiteHostAttachments: hostAttachments }
                : {}),
            }),
      })) as
        | { addedServers?: string[]; updatedSuiteEnvironment?: boolean }
        | undefined;
      const added = result?.addedServers ?? [];
      if (
        destinationMode === "existing" &&
        result?.updatedSuiteEnvironment === true &&
        added.length > 0
      ) {
        toast.success(
          `Saved as test case. Added ${added.join(", ")} to the suite.`,
        );
      } else {
        toast.success("Saved as test case");
      }
      setOpen(false);
    } catch (error) {
      const message = getBillingErrorMessage(
        error,
        "Failed to save as test case",
      );
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  // No projectId => no destination suite => no point showing the action.
  if (!projectId) {
    return null;
  }

  // Gated behind the same flag as the Evaluate sidebar entry.
  if (evaluateUiEnabled !== true) {
    return null;
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex shrink-0">
            <button
              type="button"
              aria-label="Save this prompt as a test case"
              className="flex size-6 shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground"
              onClick={() => setOpen(true)}
            >
              <FlaskConical className="h-3.5 w-3.5" aria-hidden />
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Save as test case</TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save as test case</DialogTitle>
            <DialogDescription>
              Captures this prompt and the assistant's tool calls. Turns
              with no observed tool calls can't be saved here — create a
              negative test from the Evals suite instead.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="save-as-test-case-title">Test case name</Label>
              <Input
                id="save-as-test-case-title"
                value={caseTitle}
                onChange={(e) => setCaseTitle(e.target.value)}
                placeholder="Short, descriptive name"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="save-as-test-case-destination">Destination</Label>
              <Select
                value={destinationMode}
                onValueChange={(value) =>
                  setDestinationMode(value as DestinationMode)
                }
              >
                <SelectTrigger id="save-as-test-case-destination">
                  <SelectValue placeholder="Destination" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="existing">
                    Add to existing suite
                  </SelectItem>
                  <SelectItem value="new">Create a new suite</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {destinationMode === "existing" ? (
              <div className="space-y-1.5">
                <Label htmlFor="save-as-test-case-suite">Suite</Label>
                <Select
                  value={selectedSuiteId}
                  onValueChange={setSelectedSuiteId}
                  disabled={availableSuites.length === 0}
                >
                  <SelectTrigger id="save-as-test-case-suite">
                    <SelectValue
                      placeholder={
                        suitesOverview === undefined
                          ? "Loading suites…"
                          : availableSuites.length === 0
                            ? "No suites yet — create one instead"
                            : "Pick a suite"
                      }
                    />
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
            ) : (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="save-as-test-case-new-suite">
                    New suite name
                  </Label>
                  <Input
                    id="save-as-test-case-new-suite"
                    value={newSuiteName}
                    onChange={(e) => setNewSuiteName(e.target.value)}
                    placeholder="e.g. github-issue-flow"
                  />
                </div>

                {attachmentPickersEnabled && projectId ? (
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
                          projectId={projectId}
                          value={serverAttachmentId}
                          onChange={setServerAttachmentId}
                          onClearSelection={() => setServerAttachmentId(null)}
                          disabled={submitting}
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
                        disabled={submitting}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              aria-busy={submitting}
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function seedTitleFromPrompt(prompt: string | undefined): string {
  if (!prompt) return "";
  const trimmed = prompt.replace(/\s+/g, " ").trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
}
