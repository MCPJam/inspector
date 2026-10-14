import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { track } from "@/lib/analytics";
import { AlertCircle, Download, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@mcpjam/design-system/tabs";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import { Button } from "@mcpjam/design-system/button";
import { getEffectiveSuiteServers } from "./helpers";
import type { EvalSuite } from "./types";
import { CopyableCodeBlock } from "./copyable-code-block";
import type { EvalExportCaseInput } from "@/lib/evals/eval-export";
import {
  buildAgentPromptExportFileName,
  buildSdkEnvSnippet,
  buildSdkInstallSnippet,
  buildSdkTestFile,
  buildServerConnections,
  buildSuiteExportFileName,
} from "@/lib/evals/eval-export";
import { downloadTextFile } from "@/lib/download-text-file";
import { exportServerApi } from "@/lib/apis/mcp-export-api";
import {
  generateAgentBrief,
  mapEvalCasesToAgentBriefExploreCases,
} from "@/lib/generate-agent-brief";
import { getServerUrl } from "@/components/connection/server-card-utils";
import type { ServerWithName } from "@/state/app-types";
import { stableStringifyJson } from "@mcpjam/sdk/widget-runtime";

type EvalExportModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: "suite" | "test-case";
  projectId?: string | null;
  suite: Pick<EvalSuite, "name" | "description" | "environment" | "source">;
  cases: EvalExportCaseInput[];
  serverEntries: Record<string, ServerWithName | undefined>;
};

type AgentPromptState =
  | { status: "idle"; prompt: null; error: null }
  | { status: "loading"; prompt: null; error: null }
  | {
      status: "ready";
      prompt: string;
      error: null;
      serverId: string;
      requestKey: string;
    }
  | { status: "error"; prompt: null; error: string };

function ExportStepSection({
  step,
  title,
  children,
}: {
  step: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border/60 bg-card/50 px-5 py-4">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary ring-1 ring-primary/20">
          {step}
        </span>
        <h3 className="text-sm font-semibold tracking-tight text-foreground">
          {title}
        </h3>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

export function EvalExportModal({
  open,
  onOpenChange,
  scope,
  suite,
  cases,
  serverEntries,
  projectId,
}: EvalExportModalProps) {
  const [activeTab, setActiveTab] = useState<"sdk" | "prompt">("sdk");
  const activeTabRef = useRef(activeTab);
  const [promptRetry, setPromptRetry] = useState(0);
  const [promptRequested, setPromptRequested] = useState(false);
  const [agentPromptState, setAgentPromptState] = useState<AgentPromptState>({
    status: "idle",
    prompt: null,
    error: null,
  });

  // The suite's EFFECTIVE servers, not the legacy flat list: a suite that
  // picks its server through a host or a standalone attachment leaves
  // `environment.servers` empty, which read as "no server configured" and
  // switched the agent prompt off for a suite that has one.
  const serverIds = useMemo(() => getEffectiveSuiteServers(suite), [suite]);
  const serverConnections = useMemo(
    () => buildServerConnections(serverIds, serverEntries),
    [serverEntries, serverIds]
  );
  const sdkInstallSnippet = useMemo(() => buildSdkInstallSnippet(), []);
  const sdkEnvResult = useMemo(
    () => buildSdkEnvSnippet(serverIds, serverEntries, projectId),
    [serverEntries, serverIds, projectId]
  );
  const sdkTestFile = useMemo(
    () =>
      buildSdkTestFile({
        suite,
        cases,
        serverConnections,
        usedPlaceholderFallback: sdkEnvResult.usedPlaceholderFallback,
      }),
    [cases, sdkEnvResult.usedPlaceholderFallback, serverConnections, suite]
  );

  const primaryCase = cases[0];
  const exportLabel =
    scope === "suite"
      ? suite.name || "Untitled suite"
      : primaryCase?.title || "Untitled test case";
  const downloadFileName = useMemo(
    () => buildSuiteExportFileName(exportLabel, scope),
    [exportLabel, scope]
  );
  const agentPromptDownloadFileName = useMemo(
    () => buildAgentPromptExportFileName(exportLabel),
    [exportLabel]
  );
  const singleServerId = serverIds.length === 1 ? serverIds[0]! : null;
  const serverConfig = singleServerId
    ? serverEntries[singleServerId]?.config
    : undefined;
  const promptOptions = useMemo(
    () => ({
      serverUrl: serverConfig ? getServerUrl(serverConfig) : undefined,
      exploreTestCases: mapEvalCasesToAgentBriefExploreCases(cases),
    }),
    [cases, serverConfig],
  );
  // Canonical ordering identifies equal inputs; the brief keeps authored order.
  const promptRequestKey = useMemo(
    () => stableStringifyJson({ serverId: singleServerId, ...promptOptions }),
    [singleServerId, promptOptions],
  );
  const promptOptionsRef = useRef(promptOptions);
  useLayoutEffect(() => {
    activeTabRef.current = activeTab;
    promptOptionsRef.current = promptOptions;
  }, [activeTab, promptOptions]);

  useEffect(() => {
    if (!open) {
      setActiveTab("sdk");
      setPromptRequested(false);
      return;
    }

    track("eval_export_modal_opened", {
      location: "eval_export_modal",
      scope,
      tab: "sdk_code",
      suite_source: suite.source ?? "ui",
      used_placeholder_fallback: sdkEnvResult.usedPlaceholderFallback,
    });
  }, [open, scope, sdkEnvResult.usedPlaceholderFallback, suite.source]);

  useEffect(() => {
    // SDK code uses saved cases and connection settings. Only the optional
    // agent brief needs a live server, so do not probe it during SDK export.
    // Read the selected tab without restarting a request on tab revisits.
    if (!open || !promptRequested || activeTabRef.current !== "prompt") {
      setPromptRequested(false);
      setAgentPromptState({ status: "idle", prompt: null, error: null });
      return;
    }

    if (!singleServerId) {
      setActiveTab("sdk");
      setPromptRequested(false);
      setAgentPromptState({ status: "idle", prompt: null, error: null });
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const requestOptions = promptOptionsRef.current;
    setAgentPromptState({ status: "loading", prompt: null, error: null });

    void (async () => {
      try {
        const exportPayload = await exportServerApi(singleServerId, {
          signal: controller.signal,
        });
        if (cancelled) {
          return;
        }

        const prompt = generateAgentBrief(exportPayload, requestOptions);

        setAgentPromptState({
          status: "ready",
          prompt,
          error: null,
          serverId: singleServerId,
          requestKey: promptRequestKey,
        });
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message =
          error instanceof Error
            ? error.message
            : "Live capability export failed for this server.";
        setAgentPromptState({
          status: "error",
          prompt: null,
          error: message,
        });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [promptRequested, promptRequestKey, open, promptRetry, singleServerId]);

  const promptDisabledReason = useMemo(() => {
    if (serverIds.length === 0) {
      return "Prompt for agent needs exactly one suite server, but this suite does not have a server configured yet.";
    }

    if (serverIds.length > 1) {
      return "Prompt for agent is only available when the suite targets exactly one MCP server.";
    }

    return null;
  }, [serverIds]);

  const handleDownload = () => {
    downloadTextFile(downloadFileName, sdkTestFile);
    track("eval_export_modal_downloaded", {
      location: "eval_export_modal",
      scope,
      tab: "sdk_code",
      suite_source: suite.source ?? "ui",
      used_placeholder_fallback: sdkEnvResult.usedPlaceholderFallback,
    });
  };

  const handleDownloadAgentPrompt = () => {
    if (
      agentPromptState.status !== "ready" ||
      agentPromptState.serverId !== singleServerId ||
      agentPromptState.requestKey !== promptRequestKey
    ) {
      return;
    }
    downloadTextFile(agentPromptDownloadFileName, agentPromptState.prompt);
    track("eval_export_modal_downloaded", {
      location: "eval_export_modal",
      scope,
      tab: "prompt_for_agent",
      suite_source: suite.source ?? "ui",
      used_placeholder_fallback: sdkEnvResult.usedPlaceholderFallback,
    });
  };

  const trackCopy = (tab: "sdk_code" | "prompt_for_agent", section: string) => {
    track("eval_export_modal_copied", {
      location: "eval_export_modal",
      scope,
      tab,
      section,
      suite_source: suite.source ?? "ui",
      used_placeholder_fallback: sdkEnvResult.usedPlaceholderFallback,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(92vh,960px)] max-h-[min(92vh,960px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="shrink-0 border-b border-border/60 px-6 py-5">
          <DialogTitle>
            {scope === "suite"
              ? "Export suite as SDK eval"
              : "Export test case"}
          </DialogTitle>
          <DialogDescription>
            {scope === "suite"
              ? `${cases.length} case${
                  cases.length === 1 ? "" : "s"
                } from ${exportLabel}`
              : exportLabel}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 py-5">
          <Tabs
            value={activeTab}
            onValueChange={(value) => {
              setActiveTab(value as "sdk" | "prompt");
              if (value === "prompt") setPromptRequested(true);
            }}
            className="min-h-0 flex-1 overflow-hidden"
          >
            <TabsList className="mb-4 w-full justify-start">
              <TabsTrigger value="sdk">SDK code</TabsTrigger>
              <TabsTrigger value="prompt" disabled={!singleServerId}>
                Prompt for agent
              </TabsTrigger>
            </TabsList>

            {promptDisabledReason ? (
              <Alert className="mb-4 border-border/70 bg-muted/40">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Prompt for agent unavailable</AlertTitle>
                <AlertDescription>{promptDisabledReason}</AlertDescription>
              </Alert>
            ) : null}

            <TabsContent
              value="sdk"
              className="min-h-0 flex-1 overflow-y-auto pr-1"
            >
              <div className="space-y-4 pb-1">
                {sdkEnvResult.usedPlaceholderFallback ? (
                  <Alert className="border-border/70 bg-muted/40">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>Local server details are incomplete</AlertTitle>
                    <AlertDescription>
                      Replace placeholder values for{" "}
                      {sdkEnvResult.missingServerIds.join(", ")} before running
                      the exported file.
                    </AlertDescription>
                  </Alert>
                ) : null}

                <ExportStepSection step={1} title="Install">
                  <CopyableCodeBlock
                    code={sdkInstallSnippet}
                    copyLabel="Copy install command"
                    toolbarLabel="Terminal"
                    onCopySuccess={() => trackCopy("sdk_code", "install")}
                  />
                </ExportStepSection>

                <ExportStepSection step={2} title="Set environment">
                  <CopyableCodeBlock
                    code={sdkEnvResult.snippet}
                    copyLabel="Copy environment snippet"
                    toolbarLabel="Shell"
                    onCopySuccess={() => trackCopy("sdk_code", "environment")}
                  />
                </ExportStepSection>

                <ExportStepSection step={3} title="Run the test">
                  <CopyableCodeBlock
                    code={sdkTestFile}
                    copyLabel="Copy exported SDK test file"
                    toolbarLabel={downloadFileName}
                    actions={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={handleDownload}
                        aria-label={`Download ${downloadFileName}`}
                      >
                        <Download className="h-4 w-4" />
                      </Button>
                    }
                    onCopySuccess={() => trackCopy("sdk_code", "test_file")}
                  />
                </ExportStepSection>
              </div>
            </TabsContent>

            <TabsContent
              value="prompt"
              className="flex min-h-0 flex-1 flex-col overflow-hidden pr-1"
            >
              {agentPromptState.status === "loading" ? (
                <div
                  role="status"
                  className="flex items-center gap-2 text-sm text-muted-foreground"
                >
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Checking live server capabilities to prepare the agent prompt.
                </div>
              ) : null}
              {agentPromptState.status === "error" ? (
                <Alert className="border-border/70 bg-muted/40">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Agent prompt failed. Retry below.</AlertTitle>
                  <AlertDescription>
                    <p>
                      For connection errors, check the MCP server URL. You can
                      still export saved cases from the SDK code tab.
                    </p>
                    <p className="mt-2">{agentPromptState.error}</p>
                    <Button
                      type="button"
                      variant="outline"
                      className="mt-3"
                      onClick={() => setPromptRetry((attempt) => attempt + 1)}
                    >
                      Retry agent prompt
                    </Button>
                  </AlertDescription>
                </Alert>
              ) : null}
              {agentPromptState.status === "ready" &&
              agentPromptState.serverId === singleServerId &&
              agentPromptState.requestKey === promptRequestKey ? (
                <CopyableCodeBlock
                  code={agentPromptState.prompt}
                  copyLabel="Copy prompt for agent"
                  toolbarLabel="Agent prompt.md"
                  fillHeight
                  className="min-h-0 flex-1"
                  actions={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={handleDownloadAgentPrompt}
                      aria-label={`Download ${agentPromptDownloadFileName}`}
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                  }
                  onCopySuccess={() =>
                    trackCopy("prompt_for_agent", "agent_prompt")
                  }
                />
              ) : null}
            </TabsContent>
          </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  );
}
