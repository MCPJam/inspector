import { useAction, useConvexAuth, useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, Save } from "lucide-react";
import { toast } from "@/lib/toast";
import { track } from "@/lib/analytics";
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
import { Switch } from "@mcpjam/design-system/switch";
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
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import type { EvalSuiteOverviewEntry } from "@/components/evals/types";
import { useProjectServerAttachments } from "@/hooks/useViews";
import { useHostList } from "@/hooks/useClients";
import type { HostAttachmentDraft } from "@/components/evals/client-attachments-editor";
import { ClientMultiSelect } from "@/components/hosts/client-multi-select";
import { DestinationCard } from "@/components/chat-v2/history/convert-session-dialog-core";
import { RadioGroup } from "@mcpjam/design-system/radio-group";
import { ServerPicker } from "@/components/hosts/server-picker";
import { CreateHostDialog } from "@/components/hosts/CreateHostDialog";
import { navigateToPromotedTestCase } from "@/components/chat-v2/shared/promote-to-eval-navigation";
import { isCiOwnedSuite } from "@/lib/evals/is-ci-owned-suite";
import { buildServerBasedSuiteName } from "@/components/evals/suite-environment-utils";

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
  /** Controlled open state. When set, the icon trigger is not rendered. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Clients to attach to a new suite, in place of the project's first client. */
  suggestedHostIds?: string[];
  /** Where the save started, for analytics. */
  source?: "message_menu" | "repeat_tip";
  /** Which tab rendered the action, for analytics and suite naming. */
  location?: "playground" | "chat";
  /** Servers the prompt ran against, to name a new suite. */
  serverNames?: string[];
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
  open: controlledOpen,
  onOpenChange,
  suggestedHostIds,
  source = "message_menu",
  location = "playground",
  serverNames,
}: SaveAsTestCaseActionProps) {
  const defaultSuiteName = buildServerBasedSuiteName(
    serverNames,
    location === "chat" ? "Chat suite" : "Playground suite",
  );
  const { isAuthenticated: convexAuthed } = useConvexAuth();
  const isUserReady = useDbUserReady();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const [submitting, setSubmitting] = useState(false);
  const [caseTitle, setCaseTitle] = useState(() =>
    seedTitleFromPrompt(promptPreview),
  );
  const [destinationMode, setDestinationMode] =
    useState<DestinationMode>("existing");
  const [selectedSuiteId, setSelectedSuiteId] = useState<string>("");
  const [newSuiteName, setNewSuiteName] = useState<string>(defaultSuiteName);
  const [assertToolCalls, setAssertToolCalls] = useState(false);
  // Picker state for the new-suite branch. Mirrors CreateSuiteDialog and
  // ConvertChatSessionDialog. Gated on `attachmentPickersEnabled`.
  const [serverAttachmentId, setServerAttachmentId] = useState<string | null>(
    null,
  );
  const hostsSeeded = useRef(false);
  const [hostAttachments, setHostAttachments] = useState<HostAttachmentDraft[]>(
    [],
  );

  // `attachmentPickersEnabled` also gates the "new suite requires both a
  // server and a host attachment" requirement (see `newSuiteRequirementsMet`
  // below), so it stays scoped to authed sessions with a project.
  const attachmentPickersEnabled =
    convexAuthed && isUserReady && Boolean(projectId);
  // Authed with a project, but the `users` row is still bootstrapping: the
  // pickers DO apply to this session, their data just hasn't landed. Without
  // this, `newSuiteRequirementsMet` short-circuits on the disabled pickers and
  // saves a legacy-shaped suite with no server or host attached — the exact
  // thing the requirement exists to prevent.
  const attachmentPickersPending =
    convexAuthed && !isUserReady && Boolean(projectId);

  const { serverAttachments: projectServerAttachments } =
    useProjectServerAttachments({
      isAuthenticated: open && attachmentPickersEnabled,
      projectId: open && attachmentPickersEnabled ? projectId : null,
    });
  const [createHostOpen, setCreateHostOpen] = useState(false);
  const { hosts: projectHosts, isLoading: projectHostsLoading } = useHostList({
    isAuthenticated: open && attachmentPickersEnabled,
    projectId: open && attachmentPickersEnabled ? projectId : null,
  });

  const suitesOverview = useQuery(
    "testSuites:getTestSuitesOverview" as any,
    open && isUserReady && projectId ? ({ projectId } as any) : "skip",
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
    if (
      !hostsSeeded.current &&
      hostAttachments.length === 0 &&
      projectHosts.length > 0
    ) {
      hostsSeeded.current = true;
      const suggested = (suggestedHostIds ?? []).filter((hostId) =>
        projectHosts.some((host) => host.hostId === hostId),
      );
      const hostIds =
        suggested.length > 0 ? suggested : [projectHosts[0].hostId];
      setHostAttachments(
        hostIds.map((namedHostId) => ({
          namedHostId,
          enabledOptionalServerIds: [],
        })),
      );
    }
  }, [
    open,
    attachmentPickersEnabled,
    hostAttachments.length,
    projectHosts,
    suggestedHostIds,
  ]);

  const availableSuites = useMemo(
    () =>
      (suitesOverview ?? []).filter((entry) => !isCiOwnedSuite(entry.suite)),
    [suitesOverview],
  );

  const newSuiteRequirementsMet =
    !attachmentPickersEnabled ||
    (serverAttachmentId !== null && hostAttachments.length > 0);

  const canSubmit =
    !submitting &&
    !attachmentPickersPending &&
    caseTitle.trim().length > 0 &&
    (destinationMode === "existing"
      ? Boolean(selectedSuiteId)
      : newSuiteName.trim().length > 0 && newSuiteRequirementsMet);

  const handleOpenChange = (next: boolean) => {
    if (submitting) return;
    setOpen(next);
    if (!next) {
      setCaseTitle(seedTitleFromPrompt(promptPreview));
      setAssertToolCalls(false);
      setSelectedSuiteId("");
      setNewSuiteName(defaultSuiteName);
      setDestinationMode("existing");
      setServerAttachmentId(null);
      setHostAttachments([]);
      hostsSeeded.current = false;
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
        // Older backends reject the field, so send it only when on.
        ...(assertToolCalls ? { assertToolCalls: true } : {}),
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
        | {
            suiteId?: string;
            testCaseId?: string;
            addedServers?: string[];
            updatedSuiteEnvironment?: boolean;
          }
        | undefined;
      track("playground_test_case_saved", {
        location,
        source,
        new_suite: destinationMode === "new",
        assert_tool_calls: assertToolCalls,
      });
      setOpen(false);
      // Navigating is the primary follow-through (see
      // `navigateToPromotedTestCase`); the toast stays for the environment
      // note, which the destination doesn't show, and as the only feedback
      // when the target can't be resolved.
      const navigated = navigateToPromotedTestCase({
        suiteId: result?.suiteId,
        testCaseId: result?.testCaseId,
      });
      const added = result?.addedServers ?? [];
      if (
        destinationMode === "existing" &&
        result?.updatedSuiteEnvironment === true &&
        added.length > 0
      ) {
        toast.success(
          `Saved as test case. Added ${added.join(", ")} to the suite.`,
        );
      } else if (!navigated) {
        toast.success("Saved as test case");
      }
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

  return (
    <>
      {!isControlled && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex shrink-0">
              <button
                type="button"
                aria-label="Save this prompt as a test case"
                className="flex size-6 shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground"
                onClick={() => setOpen(true)}
              >
                <Save className="h-3.5 w-3.5" aria-hidden />
              </button>
            </span>
          </TooltipTrigger>
          <TooltipContent>Save as test case</TooltipContent>
        </Tooltip>
      )}
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="flex max-h-[90vh] flex-col gap-0 sm:max-w-xl border-border/50 p-0 shadow-sm">
          <div className="px-6 pt-6">
            <DialogHeader className="space-y-1.5 pr-10">
              <DialogTitle>Save as test case</DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground">
                Saves this prompt, with its reply as the expected outcome. Turns
                with no tool calls can&apos;t be saved here.
              </DialogDescription>
            </DialogHeader>
          </div>
          <div className="min-h-0 space-y-5 overflow-y-auto px-6 py-5">
            <div className="space-y-2">
              <Label htmlFor="save-as-test-case-title">Test case name</Label>
              <Input
                id="save-as-test-case-title"
                value={caseTitle}
                onChange={(e) => setCaseTitle(e.target.value)}
                placeholder="Short, descriptive name"
                autoFocus
              />
            </div>
            <div className="space-y-3">
              <p className="text-sm font-medium text-foreground">Add to</p>
              <RadioGroup
                value={destinationMode}
                onValueChange={(next) =>
                  setDestinationMode(next === "existing" ? "existing" : "new")
                }
                aria-label="Add to"
                className="gap-2"
              >
                <DestinationCard
                  value="existing"
                  title="Existing suite"
                  selected={destinationMode === "existing"}
                  disabled={submitting}
                >
                  <div className="space-y-2">
                    <Label htmlFor="save-as-test-case-suite">Suite</Label>
                    <Select
                      value={selectedSuiteId}
                      onValueChange={setSelectedSuiteId}
                      disabled={availableSuites.length === 0}
                    >
                      <SelectTrigger
                        id="save-as-test-case-suite"
                        className="w-full"
                      >
                        <SelectValue
                          placeholder={
                            suitesOverview === undefined
                              ? "Loading suites…"
                              : availableSuites.length === 0
                                ? "No suites yet. Create one instead."
                                : "Pick a suite"
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {availableSuites.map((entry) => (
                          <SelectItem
                            key={entry.suite._id}
                            value={entry.suite._id}
                          >
                            {entry.suite.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </DestinationCard>
                <DestinationCard
                  value="new"
                  title="New suite"
                  selected={destinationMode === "new"}
                  disabled={submitting}
                >
                  <div className="space-y-2">
                    <Label htmlFor="save-as-test-case-new-suite">
                      Suite name
                    </Label>
                    <Input
                      id="save-as-test-case-new-suite"
                      value={newSuiteName}
                      onChange={(e) => setNewSuiteName(e.target.value)}
                      placeholder="e.g. github-issue-flow"
                    />
                  </div>
                  {attachmentPickersEnabled ? (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="min-w-0 space-y-2">
                        <Label htmlFor="save-as-test-case-clients">
                          Client
                        </Label>
                        <ClientMultiSelect
                          hosts={projectHosts}
                          value={hostAttachments.map(
                            (draft) => draft.namedHostId,
                          )}
                          onChange={(hostIds) => {
                            hostsSeeded.current = true;
                            setHostAttachments(
                              hostIds.map((namedHostId) => ({
                                namedHostId,
                                enabledOptionalServerIds: [],
                              })),
                            );
                          }}
                          disabled={submitting}
                          triggerId="save-as-test-case-clients"
                          inModal
                        />
                        {!projectHostsLoading && projectHosts.length === 0 ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setCreateHostOpen(true)}
                            disabled={submitting}
                          >
                            <Plus className="mr-1 h-3.5 w-3.5" />
                            Create a client
                          </Button>
                        ) : null}
                      </div>
                      <div className="min-w-0 space-y-2">
                        <Label htmlFor="save-as-test-case-server">Server</Label>
                        <ServerPicker
                          projectId={projectId}
                          value={serverAttachmentId}
                          onChange={setServerAttachmentId}
                          // Required here, so no X; the callback still goes
                          // down so a delete in the picker reaches this form.
                          onClearSelection={() => setServerAttachmentId(null)}
                          offerClear={false}
                          variant="field"
                          triggerId="save-as-test-case-server"
                          inModal
                          disabled={submitting}
                        />
                      </div>
                    </div>
                  ) : null}
                </DestinationCard>
              </RadioGroup>
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="save-as-test-case-assert-tools">
                Also save each tool call
              </Label>
              <Switch
                id="save-as-test-case-assert-tools"
                checked={assertToolCalls}
                onCheckedChange={setAssertToolCalls}
                disabled={submitting}
              />
            </div>
          </div>
          <DialogFooter className="border-t border-border/50 px-6 py-4">
            <Button
              type="button"
              variant="outline"
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
              Save as test case
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <CreateHostDialog
        isOpen={createHostOpen}
        onClose={() => setCreateHostOpen(false)}
        projectId={projectId}
        onCreated={(hostId: string) => {
          hostsSeeded.current = true;
          setHostAttachments((current) =>
            current.some((draft) => draft.namedHostId === hostId)
              ? current
              : [
                  ...current,
                  { namedHostId: hostId, enabledOptionalServerIds: [] },
                ],
          );
        }}
      />
    </>
  );
}

function seedTitleFromPrompt(prompt: string | undefined): string {
  if (!prompt) return "";
  const trimmed = prompt.replace(/\s+/g, " ").trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
}
