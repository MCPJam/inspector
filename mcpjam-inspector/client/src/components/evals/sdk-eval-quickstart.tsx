import { ExternalLink } from "lucide-react";
import { CopyableCodeBlock } from "./copyable-code-block";

const LEARN_MCP_URL = "https://learn.mcpjam.com/mcp";

// Reporting uses MCPJam API keys (sk_…, Settings → API keys): set
// MCPJAM_API_KEY and results auto-save to this project's Evals dashboard.
// Leave it unset to run and assert purely locally. The retired project API
// keys (mcpjam_…) no longer exist anywhere in this flow.
export const SDK_EVAL_QUICKSTART_ENV = `export MCP_SERVER_URL=${LEARN_MCP_URL}
export LLM_API_KEY=<your-llm-api-key>
export EVAL_MODEL=<provider/model-id> # e.g. openai/gpt-4o-mini, anthropic/claude-sonnet-4-20250514
export MCPJAM_API_KEY=<your sk_… key from Settings → API keys> # optional: saves results to MCPJam`;

export function buildSdkEvalQuickstartDotenv(
  projectId?: string | null
): string {
  return `MCP_SERVER_URL=${LEARN_MCP_URL}
LLM_API_KEY=<your-llm-api-key>
EVAL_MODEL=<provider/model-id> # e.g. openai/gpt-4o-mini, anthropic/claude-sonnet-4-20250514
MCPJAM_API_KEY=<your sk_… key from Settings → API keys> # optional: saves results to MCPJam${
    projectId ? `\nMCPJAM_PROJECT_ID=${projectId} # this project` : ""
  }`;
}

export const SDK_EVAL_QUICKSTART_DOTENV = buildSdkEvalQuickstartDotenv();

/** Snippet strings exported for tests and consistency with copy targets. */
export const SDK_EVAL_QUICKSTART_INSTALL = "npm install @mcpjam/sdk";

export const SDK_EVAL_QUICKSTART_RUN = `import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MCPClientManager, TestAgent, EvalTest } from "@mcpjam/sdk";

// MCPJam hosted learning server (tools: greet, display-mcp-app — see Learn in the app)
const SERVER_ID = "learn";
const MCP_SERVER_URL =
  process.env.MCP_SERVER_URL ?? "https://learn.mcpjam.com/mcp";
// Use the same env var you exported above (e.g. OPENAI_API_KEY instead of LLM_API_KEY).
const LLM_API_KEY = process.env.LLM_API_KEY!;
// provider/model-id — must match an allowed TestAgent provider (see Configure environment in the app or SDK README).
const MODEL = process.env.EVAL_MODEL!;

describe("MCP eval quickstart", () => {
  let manager: MCPClientManager;
  let agent: TestAgent;

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
  }, 120_000);

  afterAll(async () => {
    await manager.disconnectAllServers();
  }, 120_000);

  it(
    "agent calls greet across a two-turn case",
    async () => {
      const evalTest = new EvalTest({
        name: "learning-server-greet-multi-turn",
        expectedToolCalls: [{ toolName: "greet" }],
        test: async (agent) => {
          const r1 = await agent.prompt("Use the greet tool to say hello to Ada.");
          const r2 = await agent.prompt("Now greet Grace too.", { context: [r1] });
          return r1.hasToolCall("greet") && r2.hasToolCall("greet");
        },
      });
      // With MCPJAM_API_KEY (sk_…) set, results auto-save to your MCPJam
      // Evals dashboard; without it the run is purely local.
      await evalTest.run(agent, {
        iterations: 1,
        mcpjam: { suiteName: "Learning server quickstart" },
      });
      expect(evalTest.accuracy()).toBe(1);
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
    <div className="rounded-2xl border border-border/40 bg-card/40 px-5 py-4 shadow-sm backdrop-blur-sm">
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
/*  Backward-compat exports (used by tests)                            */
/* ------------------------------------------------------------------ */

export const SDK_EVAL_QUICKSTART_CHECKLIST_STORAGE_KEY =
  "mcp-inspector-sdk-eval-quickstart-checklist" as const;

export type SdkEvalQuickstartStepId = "install" | "configure" | "run";

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export type SdkEvalQuickstartProps = {
  projectId?: string | null;
};

export function SdkEvalQuickstart({ projectId }: SdkEvalQuickstartProps) {
  return (
    <div className="w-full max-w-4xl space-y-3">
      {/* Step 1: Set up project */}
      <StepCard step={1} title="Create a project and install the SDK">
        <CopyableCodeBlock
          code={SDK_EVAL_QUICKSTART_INSTALL}
          copyLabel="Copy install command"
          toolbarLabel="Terminal"
        />
      </StepCard>

      {/* Step 2: Set environment */}
      <StepCard step={2} title="Set environment">
        <CopyableCodeBlock
          code={buildSdkEvalQuickstartDotenv(projectId)}
          copyLabel="Copy .env"
          toolbarLabel=".env"
        />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          MCPJAM_API_KEY is an MCPJam API key (sk_…) from Settings → API keys.
          Set it and eval results save to this project automatically — leave it
          unset to run evals locally only.
        </p>
        <div className="flex justify-end text-[11px] text-muted-foreground">
          <a
            className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
            href="https://docs.mcpjam.com/sdk"
            target="_blank"
            rel="noreferrer noopener"
          >
            Learn more and see all providers in the SDK docs
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </StepCard>

      {/* Step 3: Copy the demo test */}
      <StepCard
        step={3}
        title="Add mcp-eval.quickstart.test.ts to your project"
      >
        <CopyableCodeBlock
          code={SDK_EVAL_QUICKSTART_RUN}
          copyLabel="Copy quickstart test file"
          toolbarLabel="mcp-eval.quickstart.test.ts"
        />
      </StepCard>

      {/* Step 4: Run the demo test */}
      <StepCard step={4} title="Run the demo test">
        <CopyableCodeBlock
          code="npx vitest mcp-eval.quickstart.test.ts"
          copyLabel="Copy run command"
          toolbarLabel="Terminal"
        />
      </StepCard>
    </div>
  );
}
