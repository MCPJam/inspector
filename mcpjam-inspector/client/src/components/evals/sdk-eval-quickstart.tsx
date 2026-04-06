import { useCallback, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, RefreshCw } from "lucide-react";
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@/components/ui/tooltip";
import { copyToClipboard } from "@/lib/clipboard";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { cn } from "@/lib/utils";
import { CopyableCodeBlock } from "./copyable-code-block";

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
# Match your provider's usual env var name; sync with apiKey in the sample test below.
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
export const SDK_EVAL_QUICKSTART_INSTALL = "npm install @mcpjam/sdk";

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
const promptTurns = [
  {
    id: "turn-1",
    prompt: "Use the greet tool to say hello to Ada.",
    expectedToolCalls: [{ toolName: "greet" }],
  },
  {
    id: "turn-2",
    prompt: "Now greet Grace too.",
    expectedToolCalls: [{ toolName: "greet" }],
  },
];

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
    "agent calls greet across a two-turn case",
    async () => {
      const promptResults = [];
      for (let promptIndex = 0; promptIndex < promptTurns.length; promptIndex++) {
        const promptTurn = promptTurns[promptIndex]!;
        const result = await agent.prompt(promptTurn.prompt, {
          context: promptResults.length > 0 ? promptResults : undefined,
        });
        promptResults.push(result);
      }
      const passed = promptResults.every((result) => result.hasToolCall("greet"));
      expect(passed).toBe(true);
      await reporter!.recordFromPrompts(promptResults, {
        caseTitle: "learning-server-greet-multi-turn",
        passed,
        externalCaseId: "learning-server-greet-multi-turn",
        advancedConfig: { promptTurns },
      });
    },
    90_000,
  );
});`;

/* ------------------------------------------------------------------ */
/*  StepCard                                                           */
/* ------------------------------------------------------------------ */

function StepCard({
  step,
  title,
  children,
}: {
  step: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/50 px-5 py-4">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary ring-1 ring-primary/20">
          {step}
        </span>
        <h3 className="text-sm font-semibold tracking-tight text-foreground">
          {title}
        </h3>
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  API key management                                                 */
/* ------------------------------------------------------------------ */

type ApiKeyListEntry = {
  _id: string;
  workspaceId?: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
};

function ApiKeyRow({
  isAuthLoading,
  isAuthenticated,
  workspaceId,
  maybeApiKey,
  existingKey,
  plaintextKey,
  isGenerating,
  isConfirmRegenerateOpen,
  setIsConfirmRegenerateOpen,
  onSignIn,
  onGenerate,
  onCopyKey,
  headerCopied,
}: {
  isAuthLoading: boolean;
  isAuthenticated: boolean;
  workspaceId: string | null;
  maybeApiKey: ApiKeyListEntry[] | undefined;
  existingKey: ApiKeyListEntry | null;
  plaintextKey: string | null;
  isGenerating: boolean;
  isConfirmRegenerateOpen: boolean;
  setIsConfirmRegenerateOpen: (open: boolean) => void;
  onSignIn: () => void;
  onGenerate: () => Promise<boolean>;
  onCopyKey: () => void;
  headerCopied: boolean;
}) {
  if (isAuthLoading) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2.5">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Checking...</span>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">
          MCPJAM_API_KEY
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="text-xs"
          onClick={onSignIn}
        >
          Sign in
        </Button>
      </div>
    );
  }

  if (!workspaceId) {
    return (
      <div className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">
          MCPJAM_API_KEY
        </span>
        <span className="text-xs text-muted-foreground">
          Select a workspace first
        </span>
      </div>
    );
  }

  if (maybeApiKey === undefined) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2.5">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Loading key...</span>
      </div>
    );
  }

  if (plaintextKey) {
    return (
      <TooltipProvider delayDuration={300}>
        <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2">
          <span className="shrink-0 text-xs font-medium text-muted-foreground">
            MCPJAM_API_KEY
          </span>
          <div className="relative min-w-0 flex-1">
            <Input
              readOnly
              value={plaintextKey}
              className="h-8 truncate pr-9 font-mono text-xs"
              aria-label="Workspace API key"
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0.5 top-0.5 h-7 w-7"
                  onClick={onCopyKey}
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
      <div className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">
          MCPJAM_API_KEY
        </span>
        <Button
          type="button"
          size="sm"
          variant="default"
          className="text-xs"
          disabled={isGenerating}
          onClick={() => void onGenerate()}
        >
          {isGenerating ? "Generating..." : "Generate API key"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          MCPJAM_API_KEY
        </span>
        <span className="font-mono text-xs text-muted-foreground/70">
          mcpjam_{existingKey.prefix}_...
        </span>
      </div>
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
            {isGenerating ? "Regenerating..." : "Regenerate"}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate workspace API key?</AlertDialogTitle>
            <AlertDialogDescription>
              This invalidates your current key immediately. Integrations using
              the old key will stop working. This cannot be undone.
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
                const ok = await onGenerate();
                if (ok) setIsConfirmRegenerateOpen(false);
              }}
            >
              {isGenerating ? "Regenerating..." : "Regenerate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Backward-compat exports (used by tests)                            */
/* ------------------------------------------------------------------ */

export const SDK_EVAL_QUICKSTART_CHECKLIST_STORAGE_KEY =
  "mcp-inspector-sdk-eval-quickstart-checklist" as const;

export type SdkEvalQuickstartStepId = "install" | "configure" | "run";

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

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
        "API key ready -- copy it now; the full value won't be shown again.",
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

  const dotenvEnv = buildDotEnvSnippet(plaintextKey);

  return (
    <div className="w-full max-w-2xl space-y-4">
      {/* Step 1: Install */}
      <StepCard step={1} title="Install">
        <CopyableCodeBlock
          code={SDK_EVAL_QUICKSTART_INSTALL}
          copyLabel="Copy install command"
          toolbarLabel="Terminal"
        />
      </StepCard>

      {/* Step 2: Set environment */}
      <StepCard step={2} title="Set environment">
        <ApiKeyRow
          isAuthLoading={isAuthLoading}
          isAuthenticated={isAuthenticated}
          workspaceId={workspaceId}
          maybeApiKey={maybeApiKey}
          existingKey={existingKey}
          plaintextKey={plaintextKey}
          isGenerating={isGenerating}
          isConfirmRegenerateOpen={isConfirmRegenerateOpen}
          setIsConfirmRegenerateOpen={setIsConfirmRegenerateOpen}
          onSignIn={() => {
            posthog.capture("login_button_clicked", {
              location: "sdk_eval_quickstart",
              platform: detectPlatform(),
              environment: detectEnvironment(),
            });
            void signIn();
          }}
          onGenerate={runGenerate}
          onCopyKey={() => void handleCopyHeaderKey()}
          headerCopied={headerCopied}
        />
        <CopyableCodeBlock
          code={dotenvEnv}
          copyLabel="Copy .env"
          toolbarLabel=".env"
        />
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span>
            Providers:{" "}
            <span className="text-foreground/80">
              {SDK_TEST_AGENT_PROVIDERS}
            </span>
          </span>
          <a
            className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
            href={SDK_README_URL}
            target="_blank"
            rel="noreferrer noopener"
          >
            SDK README
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </StepCard>

      {/* Step 3: Run */}
      <StepCard step={3} title="Run the test">
        <CopyableCodeBlock
          code={SDK_EVAL_QUICKSTART_RUN}
          copyLabel="Copy quickstart test file"
          toolbarLabel="mcp-eval.quickstart.test.ts"
        />
        <CopyableCodeBlock
          code="npx vitest mcp-eval.quickstart.test.ts"
          copyLabel="Copy run command"
          toolbarLabel="Terminal"
        />
      </StepCard>
    </div>
  );
}
