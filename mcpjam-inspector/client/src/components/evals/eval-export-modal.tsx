import { useEffect, useMemo, useState } from "react";
import { usePostHog } from "posthog-js/react";
import { AlertCircle, Download, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { getServerUrl } from "@/components/connection/server-card-utils";
import type { ServerWithName } from "@/state/app-types";

type EvalExportModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: "suite" | "test-case";
  suite: Pick<EvalSuite, "name" | "description" | "environment" | "source">;
  cases: EvalExportCaseInput[];
  serverEntries: Record<string, ServerWithName | undefined>;
};

type AgentPromptState =
  | { status: "idle"; prompt: null; error: null }
  | { status: "loading"; prompt: null; error: null }
  | { status: "ready"; prompt: string; error: null }
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
}: EvalExportModalProps) {
  const posthog = usePostHog();
  const [activeTab, setActiveTab] = useState<"sdk" | "prompt">("sdk");
  const [agentPromptState, setAgentPromptState] = useState<AgentPromptState>({
    status: "idle",
    prompt: null,
    error: null,
  });

  const serverIds = suite.environment?.servers ?? [];
  const serverConnections = useMemo(
    () => buildServerConnections(serverIds, serverEntries),
    [serverEntries, serverIds],
  );
  const sdkInstallSnippet = useMemo(() => buildSdkInstallSnippet(), []);
  const sdkEnvResult = useMemo(
    () => buildSdkEnvSnippet(serverIds, serverEntries),
    [serverEntries, serverIds],
  );
  const sdkTestFile = useMemo(
    () =>
      buildSdkTestFile({
        suite,
        cases,
        serverConnections,
        usedPlaceholderFallback: sdkEnvResult.usedPlaceholderFallback,
      }),
    [cases, sdkEnvResult.usedPlaceholderFallback, serverConnections, suite],
  );

  const primaryCase = cases[0];
  const exportLabel =
    scope === "suite"
      ? suite.name || "Untitled suite"
      : primaryCase?.title || "Untitled test case";
  const downloadFileName = useMemo(
    () => buildSuiteExportFileName(exportLabel, scope),
    [exportLabel, scope],
  );
  const agentPromptDownloadFileName = useMemo(
    () => buildAgentPromptExportFileName(exportLabel),
    [exportLabel],
  );
  const singleServerId = serverIds.length === 1 ? serverIds[0]! : null;
  const isPromptReady = agentPromptState.status === "ready";

  useEffect(() => {
    if (!open) {
      setActiveTab("sdk");
      return;
    }

    posthog.capture("eval_export_modal_opened", {
      scope,
      tab: "sdk_code",
      suite_source: suite.source ?? "ui",
      used_placeholder_fallback: sdkEnvResult.usedPlaceholderFallback,
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
  }, [
    open,
    posthog,
    scope,
    sdkEnvResult.usedPlaceholderFallback,
    suite.source,
  ]);

  useEffect(() => {
    if (!open) {
      setAgentPromptState({ status: "idle", prompt: null, error: null });
      return;
    }

    if (!singleServerId) {
      setAgentPromptState({ status: "idle", prompt: null, error: null });
      return;
    }

    let cancelled = false;
    setAgentPromptState({ status: "loading", prompt: null, error: null });

    void (async () => {
      try {
        const exportPayload = await exportServerApi(singleServerId);
        if (cancelled) {
          return;
        }

        const serverConfig = serverEntries[singleServerId]?.config;
        const serverUrl = serverConfig ? getServerUrl(serverConfig) : undefined;
        const prompt = generateAgentBrief(exportPayload, {
          serverUrl,
          exploreTestCases: mapEvalCasesToAgentBriefExploreCases(cases),
        });

        setAgentPromptState({
          status: "ready",
          prompt,
          error: null,
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
    };
  }, [cases, open, serverEntries, singleServerId]);

  useEffect(() => {
    if (activeTab === "prompt" && !isPromptReady) {
      setActiveTab("sdk");
    }
  }, [activeTab, isPromptReady]);

  const promptDisabledReason = useMemo(() => {
    if (serverIds.length === 0) {
      return "Prompt for agent needs exactly one suite server, but this suite does not have a server configured yet.";
    }

    if (serverIds.length > 1) {
      return "Prompt for agent is only available when the suite targets exactly one MCP server.";
    }

    if (agentPromptState.status === "loading") {
      return "Checking live server capabilities to prepare the agent prompt.";
    }

    if (agentPromptState.status === "error") {
      return `Prompt for agent is unavailable because live capability export failed: ${agentPromptState.error}`;
    }

    return null;
  }, [agentPromptState, serverIds]);

  const handleDownload = () => {
    downloadTextFile(downloadFileName, sdkTestFile);
    posthog.capture("eval_export_modal_downloaded", {
      scope,
      tab: "sdk_code",
      suite_source: suite.source ?? "ui",
      used_placeholder_fallback: sdkEnvResult.usedPlaceholderFallback,
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
  };

  const handleDownloadAgentPrompt = () => {
    if (agentPromptState.status !== "ready") {
      return;
    }
    downloadTextFile(agentPromptDownloadFileName, agentPromptState.prompt);
    posthog.capture("eval_export_modal_downloaded", {
      scope,
      tab: "prompt_for_agent",
      suite_source: suite.source ?? "ui",
      used_placeholder_fallback: sdkEnvResult.usedPlaceholderFallback,
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
  };

  const trackCopy = (tab: "sdk_code" | "prompt_for_agent", section: string) => {
    posthog.capture("eval_export_modal_copied", {
      scope,
      tab,
      section,
      suite_source: suite.source ?? "ui",
      used_placeholder_fallback: sdkEnvResult.usedPlaceholderFallback,
      platform: detectPlatform(),
      environment: detectEnvironment(),
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
              ? `${cases.length} case${cases.length === 1 ? "" : "s"} from ${exportLabel}`
              : exportLabel}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 py-5">
          <Tabs
            value={activeTab}
            onValueChange={(value) => setActiveTab(value as "sdk" | "prompt")}
            className="min-h-0 flex-1 overflow-hidden"
          >
            <TabsList className="mb-4 w-full justify-start">
              <TabsTrigger value="sdk">SDK code</TabsTrigger>
              <TabsTrigger value="prompt" disabled={!isPromptReady}>
                Prompt for agent
              </TabsTrigger>
            </TabsList>

            {!isPromptReady && promptDisabledReason ? (
              <Alert className="mb-4 border-border/70 bg-muted/40">
                {agentPromptState.status === "loading" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <AlertCircle className="h-4 w-4" />
                )}
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
              {agentPromptState.status === "ready" ? (
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
