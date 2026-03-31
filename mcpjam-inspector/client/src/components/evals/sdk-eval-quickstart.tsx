import { useCallback, useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { usePostHog } from "posthog-js/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";

const LEARN_MCP_URL = "https://learn.mcpjam.com/mcp";
const SDK_README_URL =
  "https://github.com/MCPJam/inspector/blob/main/sdk/README.md";

/** Providers supported by TestAgent — same list as @mcpjam/sdk README (TestAgent). */
export const SDK_TEST_AGENT_PROVIDERS =
  "openai, anthropic, azure, google, mistral, deepseek, ollama, openrouter, xai" as const;

const ENV_TAIL_SHELL = `export MCP_SERVER_URL=${LEARN_MCP_URL}
# EVAL_MODEL = <provider>/<model-id> (any model your vendor exposes under that provider).
# Supported providers for TestAgent: ${SDK_TEST_AGENT_PROVIDERS}
# Examples: openai/gpt-4o-mini, anthropic/claude-sonnet-4-20250514, openrouter/openai/gpt-4o-mini
export EVAL_MODEL=<provider/model-id>
# Use the API key variable your provider expects; rename in both shell and test if needed:
# OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY, etc.
export LLM_API_KEY=<your-llm-api-key>`;

const ENV_TAIL_DOTENV = `MCP_SERVER_URL=${LEARN_MCP_URL}
# EVAL_MODEL = <provider>/<model-id>. TestAgent providers: ${SDK_TEST_AGENT_PROVIDERS}
# Examples: openai/gpt-4o-mini, anthropic/claude-sonnet-4-20250514
EVAL_MODEL=<provider/model-id>
# Match your provider's usual env var name; sync with apiKey in the Vitest file below.
LLM_API_KEY=<your-llm-api-key>`;

function escapeDoubleQuotes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Build shell export block; pass plaintext after Generate/Regenerate to embed the real key. */
export function buildShellEnvSnippet(
  mcpjamApiKeyPlaintext: string | null,
): string {
  const line = mcpjamApiKeyPlaintext
    ? `export MCPJAM_API_KEY="${escapeDoubleQuotes(mcpjamApiKeyPlaintext)}"`
    : "export MCPJAM_API_KEY=<workspace-api-key>";
  return `${line}\n${ENV_TAIL_SHELL}`;
}

/** Build .env file block; pass plaintext after Generate/Regenerate to embed the real key. */
export function buildDotEnvSnippet(
  mcpjamApiKeyPlaintext: string | null,
): string {
  const line = mcpjamApiKeyPlaintext
    ? `MCPJAM_API_KEY="${escapeDoubleQuotes(mcpjamApiKeyPlaintext)}"`
    : "MCPJAM_API_KEY=<workspace-api-key>";
  return `${line}\n${ENV_TAIL_DOTENV}`;
}

/** Snippet strings exported for tests and consistency with copy targets. */
export const SDK_EVAL_QUICKSTART_INSTALL = "npm install @mcpjam/sdk vitest";

/** Placeholder shell env (no workspace key injected). */
export const SDK_EVAL_QUICKSTART_ENV = buildShellEnvSnippet(null);

export const SDK_EVAL_QUICKSTART_RUN = `import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  MCPClientManager,
  TestAgent,
  createEvalRunReporter,
} from "@mcpjam/sdk";

// MCPJam hosted learning server (tools: greet, display-mcp-app — see Learn in the app)
const SERVER_ID = "learn";
const MCP_SERVER_URL =
  process.env.MCP_SERVER_URL ?? "https://learn.mcpjam.com/mcp";
// Use the same env var you exported above (e.g. OPENAI_API_KEY instead of LLM_API_KEY).
const LLM_API_KEY = process.env.LLM_API_KEY!;
// provider/model-id — must match an allowed TestAgent provider (see Configure environment in the app or SDK README).
const MODEL = process.env.EVAL_MODEL!;
const MCPJAM_API_KEY = process.env.MCPJAM_API_KEY!;

describe("MCP eval quickstart", () => {
  let manager: MCPClientManager;
  let agent: TestAgent;
  let reporter: ReturnType<typeof createEvalRunReporter> | undefined;

  beforeAll(async () => {
    manager = new MCPClientManager();
    // Streamable HTTP — swap URL + SERVER_ID for your own MCP server
    await manager.connectToServer(SERVER_ID, { url: MCP_SERVER_URL });
    const tools = await manager.getToolsForAiSdk([SERVER_ID]);
    agent = new TestAgent({
      tools,
      model: MODEL,
      apiKey: LLM_API_KEY,
      maxSteps: 8,
      mcpClientManager: manager,
    });
    reporter = createEvalRunReporter({
      suiteName: "Quickstart suite",
      apiKey: MCPJAM_API_KEY,
      strict: true,
      mcpClientManager: manager,
      serverNames: [SERVER_ID],
      expectedIterations: 1,
    });
  }, 120_000);

  afterAll(async () => {
    if (reporter?.getAddedCount()) {
      try {
        await reporter.finalize();
      } catch (e) {
        console.warn("MCPJam reporter finalize failed (non-fatal):", e);
      }
    }
    await manager.disconnectAllServers();
  }, 120_000);

  it(
    "agent calls greet on the learning server",
    async () => {
      const result = await agent.prompt(
        "Use the greet tool to say hello to Ada.",
      );
      const passed = result.hasToolCall("greet");
      expect(passed).toBe(true);
      await reporter!.recordFromPrompt(result, {
        caseTitle: "learning-server-greet",
        passed,
        expectedToolCalls: [{ toolName: "greet" }],
      });
    },
    90_000,
  );
});`;

function QuickstartCodeBlock({
  code,
  copyLabel,
  className,
  toolbarLabel,
}: {
  code: string;
  copyLabel: string;
  className?: string;
  toolbarLabel?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(code);
    if (ok) {
      toast.success("Copied to clipboard");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      toast.error("Could not copy");
    }
  }, [code]);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-muted/30",
        className,
      )}
    >
      {toolbarLabel ? (
        <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/50 px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {toolbarLabel}
          </span>
          <button
            type="button"
            onClick={handleCopy}
            aria-label={copyLabel}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {copied ? (
              <Check className="h-4 w-4 text-green-600 dark:text-green-500" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </button>
        </div>
      ) : null}
      <div className="relative">
        <pre
          className={cn(
            "max-h-[min(420px,55vh)] overflow-auto px-4 py-3.5 text-left font-mono text-[11px] leading-relaxed text-foreground sm:text-xs",
            toolbarLabel ? "pr-4" : "pr-12",
          )}
          tabIndex={0}
        >
          <code>{code}</code>
        </pre>
        {!toolbarLabel ? (
          <button
            type="button"
            onClick={handleCopy}
            aria-label={copyLabel}
            className="absolute right-2 top-2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {copied ? (
              <Check className="h-4 w-4 text-green-600 dark:text-green-500" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </button>
        ) : null}
      </div>
    </div>
  );
}

type ApiKeyListEntry = {
  _id: string;
  workspaceId?: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
};

function EnvSnippetsTabs({
  shellCode,
  dotenvCode,
}: {
  shellCode: string;
  dotenvCode: string;
}) {
  const [tab, setTab] = useState("shell");
  const [copied, setCopied] = useState(false);
  const activeCode = tab === "shell" ? shellCode : dotenvCode;
  const activeFormat = tab === "shell" ? "Shell exports" : ".env file";

  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(activeCode);
    if (ok) {
      toast.success("Copied to clipboard");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      toast.error("Could not copy");
    }
  }, [activeCode]);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-muted/30">
      <Tabs value={tab} onValueChange={setTab} className="gap-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-muted/50 px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Environment
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <TabsList className="h-8 bg-transparent p-0">
              <TabsTrigger value="shell" className="h-8 px-2.5 text-xs">
                Shell
              </TabsTrigger>
              <TabsTrigger value="dotenv" className="h-8 px-2.5 text-xs">
                .env
              </TabsTrigger>
            </TabsList>
            <span className="hidden text-[10px] text-muted-foreground/80 sm:inline">
              {activeFormat}
            </span>
            <button
              type="button"
              onClick={handleCopy}
              aria-label="Copy environment variables"
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {copied ? (
                <Check className="h-4 w-4 text-green-600 dark:text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
        <TabsContent value="shell" className="mt-0">
          <pre className="max-h-[min(360px,50vh)] overflow-auto px-4 py-3.5 text-left font-mono text-[11px] leading-relaxed text-foreground sm:text-xs">
            <code>{shellCode}</code>
          </pre>
        </TabsContent>
        <TabsContent value="dotenv" className="mt-0">
          <pre className="max-h-[min(360px,50vh)] overflow-auto px-4 py-3.5 text-left font-mono text-[11px] leading-relaxed text-foreground sm:text-xs">
            <code>{dotenvCode}</code>
          </pre>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export const SDK_EVAL_QUICKSTART_CHECKLIST_STORAGE_KEY =
  "mcp-inspector-sdk-eval-quickstart-checklist" as const;

export type SdkEvalQuickstartStepId = "install" | "configure" | "run";

const QUICKSTART_STEPS: {
  id: SdkEvalQuickstartStepId;
  title: string;
  minutes: number;
}[] = [
  { id: "install", title: "Install", minutes: 1 },
  { id: "configure", title: "Configure environment", minutes: 3 },
  { id: "run", title: "Run the quickstart", minutes: 2 },
];

function loadQuickstartCompleted(): Set<SdkEvalQuickstartStepId> {
  try {
    const raw = localStorage.getItem(SDK_EVAL_QUICKSTART_CHECKLIST_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as string[];
    const allowed = new Set<string>(["install", "configure", "run"]);
    return new Set(
      parsed.filter((id): id is SdkEvalQuickstartStepId => allowed.has(id)),
    );
  } catch {
    return new Set();
  }
}

function saveQuickstartCompleted(ids: Set<SdkEvalQuickstartStepId>) {
  localStorage.setItem(
    SDK_EVAL_QUICKSTART_CHECKLIST_STORAGE_KEY,
    JSON.stringify([...ids]),
  );
}

function useSdkEvalQuickstartChecklist() {
  const [completed, setCompleted] = useState<Set<SdkEvalQuickstartStepId>>(
    loadQuickstartCompleted,
  );

  useEffect(() => {
    function handleStorage(e: StorageEvent) {
      if (e.key === SDK_EVAL_QUICKSTART_CHECKLIST_STORAGE_KEY) {
        setCompleted(loadQuickstartCompleted());
      }
    }
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const toggleComplete = useCallback((id: SdkEvalQuickstartStepId) => {
    setCompleted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveQuickstartCompleted(next);
      return next;
    });
  }, []);

  const checkedCount = completed.size;
  const allDone = checkedCount === QUICKSTART_STEPS.length;

  return { completed, toggleComplete, checkedCount, allDone };
}

export type SdkEvalQuickstartProps = {
  workspaceId?: string | null;
};

export function SdkEvalQuickstart({
  workspaceId = null,
}: SdkEvalQuickstartProps) {
  const [plaintextKey, setPlaintextKey] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [headerCopied, setHeaderCopied] = useState(false);
  const [isConfirmRegenerateOpen, setIsConfirmRegenerateOpen] = useState(false);
  const { completed, toggleComplete, checkedCount, allDone } =
    useSdkEvalQuickstartChecklist();

  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const { signIn } = useAuth();
  const posthog = usePostHog();

  const maybeApiKey = useQuery(
    "apiKeys:list" as any,
    workspaceId ? ({ workspaceId } as any) : "skip",
  ) as ApiKeyListEntry[] | undefined;

  const regenerateAndGet = useMutation(
    "apiKeys:regenerateAndGet" as any,
  ) as unknown as (args: { workspaceId?: string }) => Promise<{
    apiKey: string;
    key: ApiKeyListEntry;
  }>;

  const runGenerate = useCallback(async () => {
    if (!isAuthenticated || !workspaceId) return false;
    try {
      setIsGenerating(true);
      setHeaderCopied(false);
      const result = await regenerateAndGet({ workspaceId });
      setPlaintextKey(result.apiKey);
      toast.success(
        "API key ready — copy it now; the full value is not shown again after you leave this page.",
      );
      return true;
    } catch (err) {
      console.error("Failed to generate key", err);
      toast.error(
        "Could not create API key. Try again or use workspace settings.",
      );
      return false;
    } finally {
      setIsGenerating(false);
    }
  }, [isAuthenticated, workspaceId, regenerateAndGet]);

  const handleCopyHeaderKey = useCallback(async () => {
    if (!plaintextKey) return;
    const ok = await copyToClipboard(plaintextKey);
    if (ok) {
      setHeaderCopied(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setHeaderCopied(false), 2000);
    } else {
      toast.error("Could not copy");
    }
  }, [plaintextKey]);

  const activeKeys = maybeApiKey?.filter((k) => !k.revokedAt) ?? [];
  const existingKey = activeKeys.length > 0 ? activeKeys[0] : null;

  const shellEnv = buildShellEnvSnippet(plaintextKey);
  const dotenvEnv = buildDotEnvSnippet(plaintextKey);

  const apiKeyHeaderRight = (() => {
    if (isAuthLoading) {
      return (
        <span className="text-xs text-muted-foreground tabular-nums">
          Checking…
        </span>
      );
    }
    if (!isAuthenticated) {
      return (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="text-xs"
          onClick={() => {
            posthog.capture("login_button_clicked", {
              location: "sdk_eval_quickstart",
              platform: detectPlatform(),
              environment: detectEnvironment(),
            });
            void signIn();
          }}
        >
          Sign in
        </Button>
      );
    }
    if (!workspaceId) {
      return (
        <span className="max-w-[220px] text-right text-xs text-muted-foreground">
          Select a workspace to create or reveal an API key.
        </span>
      );
    }
    if (maybeApiKey === undefined) {
      return (
        <span className="text-xs text-muted-foreground">Loading key…</span>
      );
    }
    if (plaintextKey) {
      return (
        <TooltipProvider delayDuration={300}>
          <div className="flex max-w-full min-w-0 flex-1 items-center gap-2 sm:max-w-md">
            <div className="relative min-w-0 flex-1">
              <Input
                readOnly
                value={plaintextKey}
                className="h-9 truncate pr-10 font-mono text-xs"
                aria-label="Workspace API key"
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-1 top-1 h-7 w-7"
                    onClick={() => void handleCopyHeaderKey()}
                  >
                    {headerCopied ? (
                      <Check className="h-3.5 w-3.5 text-green-600" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Copy API key</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </TooltipProvider>
      );
    }
    if (!existingKey) {
      return (
        <Button
          type="button"
          size="sm"
          variant="default"
          className="shrink-0 text-xs"
          disabled={isGenerating}
          onClick={() => void runGenerate()}
        >
          {isGenerating ? "Generating…" : "Generate API key"}
        </Button>
      );
    }
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="font-mono text-xs text-muted-foreground">
          mcpjam_{existingKey.prefix}_••••••••
        </span>
        <AlertDialog
          open={isConfirmRegenerateOpen}
          onOpenChange={setIsConfirmRegenerateOpen}
        >
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              disabled={isGenerating}
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", isGenerating && "animate-spin")}
              />
              {isGenerating ? "Regenerating…" : "Regenerate"}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Regenerate workspace API key?</AlertDialogTitle>
              <AlertDialogDescription>
                This invalidates your current key immediately. Integrations
                using the old key will stop working. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isGenerating}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={isGenerating}
                onClick={async (e) => {
                  e.preventDefault();
                  const ok = await runGenerate();
                  if (ok) setIsConfirmRegenerateOpen(false);
                }}
              >
                {isGenerating ? "Regenerating…" : "Regenerate"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  })();

  return (
    <div className="w-full max-w-3xl text-left">
      <Collapsible defaultOpen={false} className="group mb-4">
        <CollapsibleTrigger
          className="flex w-full cursor-pointer items-baseline justify-between rounded-md px-3 pb-1.5 pt-2 hover:bg-muted/50"
          aria-label="SDK eval quickstart — expand checklist"
        >
          <div className="flex items-center gap-2">
            <ChevronDown
              aria-hidden
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=closed]:-rotate-90"
            />
            <div className="text-left">
              <h2 className="text-sm font-semibold text-foreground">
                SDK eval quickstart
              </h2>
              <p className="text-xs text-muted-foreground">
                Add <span className="font-medium text-foreground/90">@mcpjam/sdk</span>,
                set env, run Vitest — evals show up here.
              </p>
            </div>
          </div>
          <span
            className={`text-xs font-medium tabular-nums ${allDone ? "text-primary" : "text-muted-foreground"}`}
          >
            {checkedCount}/{QUICKSTART_STEPS.length}
            {allDone ? " ✓" : ""}
          </span>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <Accordion type="single" collapsible className="w-full">
            {QUICKSTART_STEPS.map((step, index) => {
              const n = index + 1;
              const done = completed.has(step.id);
              return (
                <AccordionItem
                  key={step.id}
                  value={step.id}
                  className="border-b border-border/40 last:border-b-0"
                >
                  <AccordionTrigger
                    className={cn(
                      "group/trigger flex w-full items-center gap-3 rounded-md py-2.5 pr-3 pl-0 text-left transition-colors hover:bg-muted/50 hover:no-underline [&>svg:last-child]:hidden",
                    )}
                  >
                    <div
                      className="flex shrink-0 items-center pl-2 pr-1"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Checkbox
                        checked={done}
                        onCheckedChange={() => {
                          toggleComplete(step.id);
                        }}
                      />
                    </div>
                    <span
                      className={cn(
                        "w-5 shrink-0 text-sm tabular-nums",
                        done
                          ? "text-muted-foreground/60"
                          : "text-muted-foreground",
                      )}
                    >
                      {n}.
                    </span>
                    <h3
                      className={cn(
                        "min-w-0 flex-1 text-base font-semibold tracking-tight",
                        done
                          ? "text-muted-foreground/60"
                          : "text-foreground",
                      )}
                    >
                      {step.title}
                    </h3>
                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground/70">
                      <Clock className="h-3 w-3" />~{step.minutes} min
                    </span>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-colors group-hover/trigger:text-muted-foreground" />
                  </AccordionTrigger>
                  <AccordionContent className="pb-4 pt-0">
                    <div className="space-y-4 border-l-2 border-border/60 pl-4 sm:pl-5">
                      {step.id === "install" ? (
                        <QuickstartCodeBlock
                          code={SDK_EVAL_QUICKSTART_INSTALL}
                          copyLabel="Copy install command"
                          toolbarLabel="bash"
                        />
                      ) : null}

                      {step.id === "configure" ? (
                        <>
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <p className="text-sm text-muted-foreground sm:max-w-[62%]">
                              Set MCP, your eval model, and LLM credentials. Paste
                              your workspace key into the snippet after you generate
                              it.
                            </p>
                            <div className="flex shrink-0 flex-col gap-2 sm:items-end sm:pl-2">
                              {apiKeyHeaderRight}
                            </div>
                          </div>
                          <ul className="list-inside list-disc space-y-1.5 text-sm text-muted-foreground marker:text-primary/70">
                            <li>
                              Defaults target the{" "}
                              <span className="font-medium text-foreground">
                                MCPJam learning server
                              </span>{" "}
                              at{" "}
                              <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">
                                {LEARN_MCP_URL}
                              </code>
                              .
                            </li>
                            <li>
                              Set{" "}
                              <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">
                                EVAL_MODEL
                              </code>{" "}
                              to{" "}
                              <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">
                                provider/model-id
                              </code>{" "}
                              (e.g.{" "}
                              <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">
                                openai/gpt-4o-mini
                              </code>
                              ).
                            </li>
                            <li>
                              Set your vendor&apos;s API key (e.g. via{" "}
                              <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">
                                LLM_API_KEY
                              </code>
                              ) and match the name in your test file.
                            </li>
                          </ul>

                          <Accordion
                            type="multiple"
                            className="rounded-lg border border-border/60"
                          >
                            <AccordionItem
                              value="mcp-url"
                              className="border-border/60 px-4"
                            >
                              <AccordionTrigger className="py-3 text-sm">
                                Custom MCP server URL
                              </AccordionTrigger>
                              <AccordionContent className="space-y-2 text-muted-foreground">
                                <p>
                                  Override{" "}
                                  <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">
                                    MCP_SERVER_URL
                                  </code>{" "}
                                  in the snippet when you want to point at your
                                  own MCP instead of the learning server (
                                  {LEARN_MCP_URL}).
                                </p>
                              </AccordionContent>
                            </AccordionItem>
                            <AccordionItem
                              value="providers"
                              className="border-border/60 px-4"
                            >
                              <AccordionTrigger className="py-3 text-sm">
                                Supported TestAgent providers
                              </AccordionTrigger>
                              <AccordionContent className="space-y-2 text-muted-foreground">
                                <p>
                                  <span className="font-medium text-foreground">
                                    Eval LLM (TestAgent)
                                  </span>{" "}
                                  uses{" "}
                                  <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">
                                    EVAL_MODEL
                                  </code>{" "}
                                  as{" "}
                                  <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">
                                    provider/model-id
                                  </code>
                                  . Allowed providers:{" "}
                                  <span className="break-words text-foreground/90">
                                    {SDK_TEST_AGENT_PROVIDERS}
                                  </span>
                                  . Pick any model string your vendor documents for
                                  that provider. Examples:{" "}
                                  <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">
                                    openai/gpt-4o-mini
                                  </code>
                                  ,{" "}
                                  <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">
                                    anthropic/claude-sonnet-4-20250514
                                  </code>
                                  ,{" "}
                                  <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">
                                    openrouter/openai/gpt-4o-mini
                                  </code>
                                  .
                                </p>
                                <p>
                                  Set the matching API key env var for your
                                  provider, or keep{" "}
                                  <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">
                                    LLM_API_KEY
                                  </code>{" "}
                                  and use the same name in the Vitest file (
                                  <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">
                                    apiKey
                                  </code>
                                  ).
                                </p>
                              </AccordionContent>
                            </AccordionItem>
                            <AccordionItem
                              value="docs"
                              className="border-border/60 px-4"
                            >
                              <AccordionTrigger className="py-3 text-sm">
                                Docs and patterns
                              </AccordionTrigger>
                              <AccordionContent className="space-y-2 text-muted-foreground">
                                <p>
                                  Generate or regenerate your workspace key above
                                  to insert{" "}
                                  <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">
                                    MCPJAM_API_KEY
                                  </code>{" "}
                                  into the snippet.
                                </p>
                                <p>
                                  For more detail and patterns, see the{" "}
                                  <a
                                    className="font-medium text-primary underline-offset-4 hover:underline"
                                    href={SDK_README_URL}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                  >
                                    @mcpjam/sdk README
                                  </a>
                                  .
                                </p>
                              </AccordionContent>
                            </AccordionItem>
                          </Accordion>

                          {!plaintextKey ? (
                            <p className="text-xs text-muted-foreground">
                              API keys are only shown in full right after you create
                              or regenerate them. If you already have a key, use
                              Regenerate to reveal a new one here.
                            </p>
                          ) : null}

                          <EnvSnippetsTabs
                            shellCode={shellEnv}
                            dotenvCode={dotenvEnv}
                          />
                        </>
                      ) : null}

                      {step.id === "run" ? (
                        <>
                          <p className="text-sm text-muted-foreground">
                            Save the sample test, run Vitest once, and your suite
                            and run show up here.
                          </p>
                          <p className="text-sm text-muted-foreground">
                            Save as{" "}
                            <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                              mcp-eval.quickstart.test.ts
                            </code>{" "}
                            next to your config.
                          </p>
                          <QuickstartCodeBlock
                            code={SDK_EVAL_QUICKSTART_RUN}
                            copyLabel="Copy quickstart test file"
                            toolbarLabel="TypeScript"
                          />
                          <p className="text-sm text-muted-foreground">
                            Run{" "}
                            <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                              npx vitest mcp-eval.quickstart.test.ts
                            </code>
                            . After a successful run, your suite and run appear in
                            this view.
                          </p>
                        </>
                      ) : null}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
