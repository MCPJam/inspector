import { useCallback, useState } from "react";
import { useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { Check, ExternalLink, KeyRound, Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { CopyableCodeBlock } from "./copyable-code-block";
import { CreateApiKeyDialog } from "../settings/api-keys/CreateApiKeyDialog";
import { useApiKeys } from "@/hooks/useApiKeys";
import { useOrganizationQueries } from "@/hooks/useOrganizations";
import { writeApiKeysSignInReturnPath } from "@/lib/api-keys-signin-return-path";
import { routePaths } from "@/lib/app-navigation";
import { useSharedAppState } from "@/state/app-state-context";
import { findProjectByAnyId } from "@/state/app-types";

const LEARN_MCP_URL = "https://learn.mcpjam.com/mcp";

// Reporting uses MCPJam API keys (sk_…, Settings → API keys): set
// MCPJAM_API_KEY and results auto-save to this project's Evals dashboard.
// Leave it unset to run and assert purely locally. The retired project API
// keys (mcpjam_…) no longer exist anywhere in this flow.
export const SDK_EVAL_QUICKSTART_ENV = `export MCP_SERVER_URL=${LEARN_MCP_URL}
export LLM_API_KEY=<your-llm-api-key>
export EVAL_MODEL=<provider/model-id> # e.g. openai/gpt-4o-mini, anthropic/claude-sonnet-4-20250514
export MCPJAM_API_KEY=<your sk_… key from Settings → API keys> # optional: saves results to MCPJam`;

/**
 * The rendered `.env` block.
 *
 * `apiKey` is the plaintext `sk_…` value from an in-app mint, injected so the
 * copy button hands over a snippet that WORKS rather than one with a
 * placeholder the user has to go fill in from another page. It lives in
 * component state for the life of the mount and is never persisted — WorkOS
 * shows a key value exactly once, which is why the injected variant carries
 * its own "copy it now" warning.
 *
 * The shell-export twin (`SDK_EVAL_QUICKSTART_ENV`) is deliberately NOT
 * key-aware: it is a static export other surfaces read, and a second live
 * placeholder site would be a second thing to keep in sync.
 */
export function buildSdkEvalQuickstartDotenv(
  projectId?: string | null,
  apiKey?: string | null,
): string {
  const keyLine = apiKey
    ? `MCPJAM_API_KEY=${apiKey} # shown once — copy this now, it can't be retrieved later`
    : `MCPJAM_API_KEY=<your sk_… key from Settings → API keys> # optional: saves results to MCPJam`;
  return `MCP_SERVER_URL=${LEARN_MCP_URL}
LLM_API_KEY=<your-llm-api-key>
EVAL_MODEL=<provider/model-id> # e.g. openai/gpt-4o-mini, anthropic/claude-sonnet-4-20250514
${keyLine}${
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
        // A case's identity. Mint it once (mintCaseId() from
        // "@mcpjam/sdk/contract") and keep the literal — history joins on the
        // id, so renaming the case below never forks it.
        id: "c_learning_server_greet",
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

export type SdkEvalQuickstartStepId = "install" | "configure" | "run";

/* ------------------------------------------------------------------ */
/*  Step 2 — inline API-key mint                                       */
/* ------------------------------------------------------------------ */

/**
 * Mint the key HERE instead of sending the reader to Settings → API keys.
 *
 * The trip to settings is where activation used to end: it is a different
 * surface, it loses the quickstart's scroll position, and the key it reveals
 * has to be hand-carried back into a snippet on this page. Minting inline
 * means the `.env` block below already contains a working key by the time
 * the reader copies it.
 */
function CreateApiKeyStep({
  onKeyCreated,
  hasKey,
  projectId,
}: {
  onKeyCreated: (value: string) => void;
  hasKey: boolean;
  projectId?: string | null;
}) {
  const { isAuthenticated } = useConvexAuth();
  // Guests hold a Convex identity too, so signed-in-ness is the WorkOS user:
  // /api/web/api-keys rejects guest sessions outright.
  //
  // `isLoading` matters as much as `user`: before WorkOS resolves, `user` is
  // absent and a signed-in reader would see the guest sign-in CTA flash — and
  // could click it into a pointless redirect. Same guard `ApiKeysRoute` uses.
  const { user, signIn, isLoading: isAuthLoading } = useAuth();
  const isSignedIn = Boolean(user);
  const { sortedOrganizations, isLoading: orgsLoading } =
    useOrganizationQueries({ isAuthenticated });
  const {
    keys,
    error: listError,
    create,
    isCreating,
  } = useApiKeys({ enabled: isSignedIn });

  // The key must belong to the org that owns THIS project, or ingestion
  // rejects it ("API key is not scoped to this organization"). A multi-org
  // reader offered the full org list could mint a key that cannot possibly
  // authorize the `MCPJAM_PROJECT_ID` in the very snippet below, and would
  // only find out from a failing CI run. Narrow the choice instead of
  // validating it after the fact.
  const appState = useSharedAppState();
  const projectOrganizationId =
    findProjectByAnyId(appState.projects, projectId ?? null)?.organizationId ??
    null;
  // Having a project we CANNOT resolve an org for is a guarded state, not a
  // reason to reopen the full list. Both causes are reachable — app state not
  // yet hydrated, and `Project.organizationId` being optional — and in either
  // one, offering every org to a multi-org reader restores exactly the
  // key/project mismatch this narrowing exists to prevent. Only a genuinely
  // project-less quickstart falls back to the unfiltered list, because there
  // is no project for a key to mismatch.
  const isProjectOrgUnresolved = Boolean(projectId) && !projectOrganizationId;
  const mintableOrganizations = projectOrganizationId
    ? sortedOrganizations.filter((org) => org._id === projectOrganizationId)
    : isProjectOrgUnresolved
      ? []
      : sortedOrganizations;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);

  // Either half counts as available: a key minted in this session, or an
  // account that already has one. The list endpoint does not include the
  // binding's project organization, so do not claim that an existing key was
  // created for this project; the .env copy still asks the reader to paste it.
  const keyReady = hasKey || keys.length > 0;

  const handleSignIn = useCallback(() => {
    writeApiKeysSignInReturnPath(routePaths.evalsRuns);
    signIn();
  }, [signIn]);

  const handleCreate = useCallback(
    async ({
      name,
      organizationId,
    }: {
      name: string;
      organizationId: string;
    }) => {
      setMintError(null);
      try {
        const created = await create({ name, organizationId });
        setDialogOpen(false);
        onKeyCreated(created.value);
      } catch (error) {
        // Rendered in place rather than toasted: this card is one of several
        // in a scrolling page, and the failure belongs next to the button
        // that caused it. A 409 here is the WorkOS org sync still catching
        // up — its message already says "try again shortly".
        //
        // The dialog CLOSES on failure. It is modal, so Radix `aria-hidden`s
        // everything behind it: an error left rendered under an open dialog
        // is invisible to the reader and absent from the accessibility tree.
        // Retrying is one click on the same button.
        setDialogOpen(false);
        setMintError(
          error instanceof Error
            ? error.message
            : "Failed to create API key. Please try again.",
        );
        throw error;
      }
    },
    [create, onKeyCreated],
  );

  return (
    <div className="space-y-2">
      {isAuthLoading ? (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          Checking your session…
        </div>
      ) : isSignedIn ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            // Disabled rather than silently minting into the wrong org — see
            // `isProjectOrgUnresolved` above. Held only for as long as the
            // project's organization is genuinely unknown.
            disabled={isProjectOrgUnresolved}
            onClick={() => setDialogOpen(true)}
          >
            {isCreating ? (
              <Loader2 className="mr-2 size-3.5 animate-spin" aria-hidden />
            ) : (
              <KeyRound className="mr-2 size-3.5" aria-hidden />
            )}
            Create API key
          </Button>
          {isProjectOrgUnresolved ? (
            <span className="text-[11px] text-muted-foreground">
              Resolving this project's organization…
            </span>
          ) : null}
          {keyReady ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
              <Check className="size-3.5" aria-hidden />
              API key available
            </span>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={handleSignIn}>
            Sign in to create an API key
          </Button>
          <span className="text-[11px] text-muted-foreground">
            You'll come right back here.
          </span>
        </div>
      )}

      {mintError ? (
        <p
          role="alert"
          className="text-[11px] leading-relaxed text-destructive"
        >
          {mintError}
        </p>
      ) : null}
      {listError && !mintError ? (
        <p
          role="alert"
          className="text-[11px] leading-relaxed text-destructive"
        >
          {listError}
        </p>
      ) : null}

      <CreateApiKeyDialog
        open={dialogOpen}
        onOpenChange={(next) => {
          setDialogOpen(next);
          if (!next) setMintError(null);
        }}
        isCreating={isCreating}
        organizations={mintableOrganizations}
        orgsLoading={orgsLoading}
        onCreate={handleCreate}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export type SdkEvalQuickstartProps = {
  projectId?: string | null;
};

export function SdkEvalQuickstart({ projectId }: SdkEvalQuickstartProps) {
  // The one-time plaintext key value, held for the life of this mount so the
  // `.env` snippet below can carry it. Never written to storage or a state
  // store — WorkOS reveals it exactly once.
  const [mintedKey, setMintedKey] = useState<string | null>(null);
  // …and dropped the moment the project changes. This component survives a
  // project switch, so without this the snippet would pair the PREVIOUS
  // project's key with the new project's `MCPJAM_PROJECT_ID` — a combination
  // ingestion rejects, discovered only from a failing CI run.
  const [keyProjectId, setKeyProjectId] = useState<string | null>(null);
  if (mintedKey !== null && keyProjectId !== (projectId ?? null)) {
    setMintedKey(null);
    setKeyProjectId(null);
  }

  const handleKeyCreated = useCallback(
    (value: string) => {
      setMintedKey(value);
      setKeyProjectId(projectId ?? null);
    },
    [projectId],
  );

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
        <CreateApiKeyStep
          onKeyCreated={handleKeyCreated}
          hasKey={mintedKey !== null}
          projectId={projectId}
        />
        <CopyableCodeBlock
          code={buildSdkEvalQuickstartDotenv(projectId, mintedKey)}
          copyLabel="Copy .env"
          toolbarLabel=".env"
          sensitive={mintedKey !== null}
        />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {mintedKey
            ? "Your new key is in the snippet above and won't be shown again — copy it now. Eval results save to this project automatically."
            : "MCPJAM_API_KEY is an MCPJam API key (sk_…). Create one above (or paste an existing key from Settings → API keys) and eval results save to this project automatically — leave it unset to run evals locally only."}
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

      {/*
        The arrival signal. No polling: the tab already re-renders reactively
        off `getTestSuitesOverview`, and the first ingested run stamps
        `suite.lastSdkRunAt`, which flips `hasVisibleSuites` and swaps this
        whole quickstart out for the populated view. Existing non-CI runs use
        the project-wide table instead, so they are never hidden behind this
        onboarding state.
      */}
      <div className="flex items-center justify-center gap-2.5 pt-1 text-xs text-muted-foreground">
        <span className="relative flex h-2 w-2" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
        </span>
        <span>
          Waiting for your first run… this page updates automatically.
        </span>
      </div>
    </div>
  );
}
