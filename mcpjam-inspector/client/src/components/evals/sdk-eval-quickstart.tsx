import { useCallback, useState } from "react";
import { Check, Copy, RefreshCw } from "lucide-react";
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
}: {
  code: string;
  copyLabel: string;
  className?: string;
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
        "relative rounded-lg border border-border bg-muted/40",
        className,
      )}
    >
      <pre
        className="max-h-[min(420px,55vh)] overflow-auto p-4 pr-12 text-left font-mono text-xs leading-relaxed text-foreground"
        tabIndex={0}
      >
        <code>{code}</code>
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copyLabel}
        className="absolute right-2 top-2 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {copied ? (
          <Check className="h-4 w-4 text-green-600 dark:text-green-500" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
      </button>
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
    <div className="relative rounded-lg border border-border bg-muted/40">
      <Tabs value={tab} onValueChange={setTab} className="gap-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
          <TabsList className="h-8 bg-transparent p-0">
            <TabsTrigger value="shell" className="h-8 px-2.5 text-xs">
              Shell
            </TabsTrigger>
            <TabsTrigger value="dotenv" className="h-8 px-2.5 text-xs">
              .env
            </TabsTrigger>
          </TabsList>
          <button
            type="button"
            onClick={handleCopy}
            aria-label="Copy environment variables"
            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {copied ? (
              <Check className="h-4 w-4 text-green-600 dark:text-green-500" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </button>
        </div>
        <TabsContent value="shell" className="mt-0">
          <pre className="max-h-[min(360px,50vh)] overflow-auto p-4 text-left font-mono text-xs leading-relaxed text-foreground">
            <code>{shellCode}</code>
          </pre>
        </TabsContent>
        <TabsContent value="dotenv" className="mt-0">
          <pre className="max-h-[min(360px,50vh)] overflow-auto p-4 text-left font-mono text-xs leading-relaxed text-foreground">
            <code>{dotenvCode}</code>
          </pre>
        </TabsContent>
      </Tabs>
    </div>
  );
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
    <div className="w-full max-w-3xl space-y-8 text-left">
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">Install</h3>
        <QuickstartCodeBlock
          code={SDK_EVAL_QUICKSTART_INSTALL}
          copyLabel="Copy install command"
        />
      </div>

      <div className="space-y-2">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <h3 className="text-sm font-semibold text-foreground shrink-0">
            Configure environment
          </h3>
          <div className="flex min-w-0 flex-1 flex-col items-stretch gap-2 sm:items-end">
            {apiKeyHeaderRight}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Snippets default to the{" "}
          <span className="font-medium text-foreground">
            MCPJam learning server
          </span>{" "}
          ({LEARN_MCP_URL}); override{" "}
          <code className="rounded bg-muted px-1 font-mono">
            MCP_SERVER_URL
          </code>{" "}
          for your own MCP.{" "}
          <span className="font-medium text-foreground">
            Eval LLM (TestAgent)
          </span>
          : use{" "}
          <code className="rounded bg-muted px-1 font-mono">EVAL_MODEL</code> in
          the form{" "}
          <code className="rounded bg-muted px-1 font-mono">
            provider/model-id
          </code>{" "}
          (for example{" "}
          <code className="rounded bg-muted px-1 font-mono">
            openai/gpt-4o-mini
          </code>
          ). Allowed providers are{" "}
          <span className="whitespace-normal break-words text-foreground/90">
            {SDK_TEST_AGENT_PROVIDERS}
          </span>
          — pick any model string your vendor documents for that provider. Set
          the matching API key env var (or keep{" "}
          <code className="rounded bg-muted px-1 font-mono">LLM_API_KEY</code>{" "}
          and the same name in the test file). Generate or regenerate above to
          insert your MCPJam key. For detail and patterns, see{" "}
          <a
            className="text-primary underline-offset-4 hover:underline"
            href="https://github.com/MCPJam/inspector/blob/main/sdk/README.md"
            target="_blank"
            rel="noreferrer noopener"
          >
            @mcpjam/sdk README
          </a>
          .
        </p>
        {!plaintextKey && (
          <p className="text-xs text-muted-foreground">
            API keys are only shown in full right after you create or regenerate
            them. If you already have a key, use Regenerate to reveal a new one
            here.
          </p>
        )}
        <EnvSnippetsTabs shellCode={shellEnv} dotenvCode={dotenvEnv} />
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">
          Run the quickstart
        </h3>
        <p className="text-xs font-medium text-muted-foreground">
          <code className="rounded bg-muted px-1 py-0.5 font-mono">
            mcp-eval.quickstart.test.ts
          </code>
        </p>
        <QuickstartCodeBlock
          code={SDK_EVAL_QUICKSTART_RUN}
          copyLabel="Copy quickstart test file"
        />
        <p className="text-xs text-muted-foreground">
          Run with{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono">
            npx vitest mcp-eval.quickstart.test.ts
          </code>
          . After a successful run, your suite and run appear in this view.
        </p>
      </div>
    </div>
  );
}
