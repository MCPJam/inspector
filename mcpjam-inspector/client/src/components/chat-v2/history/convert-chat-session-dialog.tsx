import { useAction, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
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
import { Textarea } from "@mcpjam/design-system/textarea";
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

type ConvertChatSessionDialogProps = {
  open: boolean;
  session: ChatHistorySession | null;
  workspaceId: string | null;
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
  workspaceId,
  requestHeaders,
  onOpenChange,
  onImported,
}: ConvertChatSessionDialogProps) {
  const effectiveWorkspaceId = session?.workspaceId ?? workspaceId ?? null;
  const suitesOverview = useQuery(
    "testSuites:getTestSuitesOverview" as any,
    open && effectiveWorkspaceId
      ? ({ workspaceId: effectiveWorkspaceId } as any)
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
  const [newSuiteDescription, setNewSuiteDescription] = useState("");
  const [sessionServers, setSessionServers] = useState<string[]>([]);
  const [updateSuiteEnvironment, setUpdateSuiteEnvironment] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

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

  const missingServers = useMemo(() => {
    if (!selectedSuiteEntry) {
      return [];
    }
    const suiteServers = normalizeServerNames(
      selectedSuiteEntry.suite.environment?.servers,
    );
    return sessionServers.filter(
      (serverName) =>
        !suiteServers.some(
          (configuredServer) =>
            configuredServer.toLowerCase() === serverName.toLowerCase(),
        ),
    );
  }, [selectedSuiteEntry, sessionServers]);

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
            workspaceId: effectiveWorkspaceId ?? undefined,
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
        setSessionServers(selectedServers);
        setNewSuiteName(
          buildServerBasedSuiteName(selectedServers, `${title} suite`),
        );
        setNewSuiteDescription(
          `Imported from chat session "${title}".`,
        );
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
  }, [effectiveWorkspaceId, open, requestHeaders, session]);

  useEffect(() => {
    if (!open) {
      setDetailError(null);
      setSessionServers([]);
      setUpdateSuiteEnvironment(false);
      setIsSubmitting(false);
    }
  }, [open]);

  const canSubmit =
    Boolean(session) &&
    Boolean(effectiveWorkspaceId) &&
    !detailLoading &&
    !detailError &&
    caseTitle.trim().length > 0 &&
    !isSubmitting &&
    (destinationMode === "new"
      ? newSuiteName.trim().length > 0
      : Boolean(selectedSuiteId) &&
        (missingServers.length === 0 || updateSuiteEnvironment));

  const handleSubmit = async () => {
    if (!session || !effectiveWorkspaceId || !canSubmit) {
      return;
    }

    setIsSubmitting(true);
    try {
      const result = (await importChatSession({
        sessionId: session._id,
        workspaceId: effectiveWorkspaceId,
        ...(destinationMode === "existing"
          ? {
              destinationSuiteId: selectedSuiteId,
              updateSuiteEnvironment,
            }
          : {
              newSuiteName: newSuiteName.trim(),
              newSuiteDescription: newSuiteDescription.trim() || undefined,
            }),
        testCaseTitle: caseTitle.trim(),
      })) as {
        suiteId: string;
        testCaseId: string;
        createdSuite?: boolean;
        updatedSuiteEnvironment?: boolean;
      };

      toast.success("Chat session converted to a test case");
      onOpenChange(false);
      onImported({ suiteId: result.suiteId, testCaseId: result.testCaseId });
    } catch (error) {
      toast.error(
        getBillingErrorMessage(error, "Failed to convert chat session"),
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const sessionTitle = getSessionTitle(session);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Convert to test case</DialogTitle>
          <DialogDescription>
            Turn this chat session into a normal suite-backed eval case. The
            full session will be compiled into multi-turn `promptTurns`.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid gap-2">
            <Label htmlFor="chat-import-case-title">Case title</Label>
            <Input
              id="chat-import-case-title"
              value={caseTitle}
              onChange={(event) => setCaseTitle(event.target.value)}
              placeholder={sessionTitle}
            />
          </div>

          <div className="space-y-2">
            <div>
              <h3 className="text-sm font-medium text-foreground">
                Session servers
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Imported from the chat session&apos;s selected server set.
              </p>
            </div>
            {detailLoading ? (
              <div className="flex items-center gap-2 rounded-lg border px-3 py-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading chat session details…
              </div>
            ) : detailError ? (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Import unavailable</AlertTitle>
                <AlertDescription>{detailError}</AlertDescription>
              </Alert>
            ) : !effectiveWorkspaceId ? (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Import unavailable</AlertTitle>
                <AlertDescription>
                  This chat session is not linked to a shared workspace yet, so
                  it cannot be converted into a suite-backed test case.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="flex flex-wrap gap-2 rounded-lg border bg-card/50 px-3 py-3">
                {sessionServers.length > 0 ? (
                  sessionServers.map((serverName) => (
                    <span
                      key={serverName}
                      className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground"
                    >
                      {serverName}
                    </span>
                  ))
                ) : (
                  <span className="text-sm text-muted-foreground">
                    No servers were stored on this session.
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div>
              <h3 className="text-sm font-medium text-foreground">
                Destination suite
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Import into an existing suite or create a new one.
              </p>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                type="button"
                variant={destinationMode === "new" ? "default" : "outline"}
                onClick={() => setDestinationMode("new")}
              >
                Create new suite
              </Button>
              <Button
                type="button"
                variant={destinationMode === "existing" ? "default" : "outline"}
                onClick={() => setDestinationMode("existing")}
                disabled={availableSuites.length === 0}
              >
                Use existing suite
              </Button>
            </div>

            {destinationMode === "new" ? (
              <div className="space-y-3 rounded-xl border bg-card/60 p-4">
                <div className="grid gap-2">
                  <Label htmlFor="chat-import-suite-name">Suite name</Label>
                  <Input
                    id="chat-import-suite-name"
                    value={newSuiteName}
                    onChange={(event) => setNewSuiteName(event.target.value)}
                    placeholder="Imported suite"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="chat-import-suite-description">
                    Description
                  </Label>
                  <Textarea
                    id="chat-import-suite-description"
                    value={newSuiteDescription}
                    onChange={(event) =>
                      setNewSuiteDescription(event.target.value)
                    }
                    placeholder="Optional suite description"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-3 rounded-xl border bg-card/60 p-4">
                <div className="grid gap-2">
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

        <DialogFooter>
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
            Convert to test case
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
