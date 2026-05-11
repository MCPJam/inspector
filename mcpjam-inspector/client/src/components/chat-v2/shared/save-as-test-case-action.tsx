import { useAction, useQuery } from "convex/react";
import { useMemo, useState } from "react";
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

type SaveAsTestCaseActionProps = {
  sessionId: string;
  userMessageId: string;
  /** Used to seed the test-case title; not sent to the server. */
  promptPreview?: string;
  /** Required to fetch suites and create a new suite when needed. */
  projectId: string | null;
};

type DestinationMode = "existing" | "new";

/**
 * Per-user-message overflow action that promotes a single chat turn into a
 * test case. The Convex action does the heavy lifting (slicing the
 * transcript, compiling the prompt turn, refusing turns with no observed
 * tool calls); this component is just a small affordance + form.
 */
export function SaveAsTestCaseAction({
  sessionId,
  userMessageId,
  promptPreview,
  projectId,
}: SaveAsTestCaseActionProps) {
  const playgroundEnabled = useFeatureFlagEnabled("playground-enabled");
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [caseTitle, setCaseTitle] = useState(() =>
    seedTitleFromPrompt(promptPreview),
  );
  const [destinationMode, setDestinationMode] =
    useState<DestinationMode>("existing");
  const [selectedSuiteId, setSelectedSuiteId] = useState<string>("");
  const [newSuiteName, setNewSuiteName] = useState<string>("");

  const suitesOverview = useQuery(
    "testSuites:getTestSuitesOverview" as any,
    open && projectId ? ({ projectId } as any) : "skip",
  ) as EvalSuiteOverviewEntry[] | undefined;

  const saveAsTestCase = useAction(
    "testSuites:saveAsTestCaseFromChatMessage" as any,
  );

  const availableSuites = useMemo(
    () =>
      (suitesOverview ?? []).filter((entry) => entry.suite.source !== "sdk"),
    [suitesOverview],
  );

  const canSubmit =
    !submitting &&
    caseTitle.trim().length > 0 &&
    (destinationMode === "existing"
      ? Boolean(selectedSuiteId)
      : newSuiteName.trim().length > 0);

  const handleOpenChange = (next: boolean) => {
    if (submitting) return;
    setOpen(next);
    if (!next) {
      setCaseTitle(seedTitleFromPrompt(promptPreview));
      setSelectedSuiteId("");
      setNewSuiteName("");
      setDestinationMode("existing");
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit || !projectId) {
      return;
    }
    setSubmitting(true);
    try {
      await saveAsTestCase({
        sessionId,
        userMessageId,
        projectId,
        testCaseTitle: caseTitle.trim(),
        ...(destinationMode === "existing"
          ? { destinationSuiteId: selectedSuiteId }
          : { newSuiteName: newSuiteName.trim() }),
      });
      toast.success("Saved as test case");
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

  // Gated behind the same flag as the Playground/Evals sidebar entry.
  if (playgroundEnabled !== true) {
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
              Captures this prompt and the assistant's tool calls. Only works
              when the assistant actually called a tool on this turn.
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
