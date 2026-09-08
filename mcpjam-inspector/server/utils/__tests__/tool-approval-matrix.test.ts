/**
 * THE approval matrix: family × engine × switch → gate | free.
 *
 * Approval is declared through TWO channels today, and each engine reads only
 * one of them:
 *
 *   - `tool.needsApproval` on the AI SDK tool object — written by every
 *     builder, read by the BYOK `streamText` path.
 *   - `uiToolApprovals`, a name set threaded by the route — read by the MCPJam
 *     emulated loop (`toolCallNeedsApproval`) and, through it, the hosted-org
 *     engine.
 *
 * So a family that fills only one channel is silently wrong on the other
 * engine, and no single file says what the answer is supposed to be. This one
 * does: every row states the family, what its builder actually produces, what
 * its route actually threads, and what each engine then does with the switch
 * on and off.
 *
 * HOW EACH ENGINE IS DRIVEN — deliberately not a shared abstraction over the
 * two, because the point is that they are different readers:
 *
 *   - `mcpjam` runs a whole turn through `handleMCPJamFreeChatModel` with a
 *     fake model emitting one `tool-call`, and asks whether a
 *     `tool-approval-request` chunk followed. That is the user-visible pill.
 *   - `byok` evaluates `tools[name].needsApproval` — the value `streamText`
 *     reads — invoking it with a representative input when it is a function.
 *
 * SIX ROWS ARE MARKED `DIVERGENCE`. They are written as the behaviour that
 * ships today, not as the behaviour the code's own comments and docs promise,
 * so this file is green on `main`. Every one is the same shape — a family
 * whose declaration the MCPJam engine cannot see, because it is not in any
 * name set — and PR 2 flips exactly these six.
 *
 * Three of them are the findings the plan named (local bash, workspace reads,
 * server-origin skill refs). The other three fell out of writing the table:
 * pinned skill tools, `app_*` and exa `web_search` all declare a `never` floor
 * that the MCPJam engine overrides with the switch. Same mechanism, same fix,
 * and worth stating rather than discovering during PR 2's review.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import {
  classifyBrowserToolApprovals,
  classifyPageToolApprovals,
  classifyUiToolApprovals,
  type UiToolApprovalClassification,
} from "@/shared/client-fulfilled-tools";
import { hasUnresolvedToolCalls } from "@/shared/http-tool-calls";
import {
  handleMCPJamFreeChatModel,
  toolCallNeedsApproval,
} from "../mcpjam-stream-handler";
import { mcpToolOptionsFor } from "../mcp-tool-options";
import {
  applySkillToolApproval,
  buildAppTools,
  buildPageTools,
  buildUiTools,
} from "../chat-v2-orchestration";
import { buildBashTool } from "../built-in-tools/bash";
import { buildSandboxBashTool } from "../built-in-tools/sandbox-bash";
import { buildMcpjamTool } from "../built-in-tools/mcpjam";
import { buildBrowserTools } from "../built-in-tools/browser";
import { buildExaWebSearchTool } from "../built-in-tools/exa-web-search";
import { createProgressiveMetaTools } from "../progressive-tool-meta-tools";
import { createPinnedSkillTools } from "../computers/cloud-skill-tools";
import { createEffectiveSkillTools } from "../computers/effective-skill-tools";
import type { BrowserSessionHandle } from "../../services/browserd/browser-session";

// ── engine harness ─────────────────────────────────────────────────────────
//
// Same shape as `mcpjam-stream-handler.test.ts`: the handler's stream writer is
// captured so the emitted chunks can be read back, and the Convex hop is a
// canned SSE body.

let lastExecution: Promise<void> | null = null;
let writtenChunks: any[] = [];

const createSseResponse = (events: any[]) => {
  const payload = `${events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")}data: [DONE]\n\n`;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    createUIMessageStream: vi.fn(({ execute, onFinish }) => {
      const writer = {
        write: vi.fn((chunk) => {
          writtenChunks.push(chunk);
        }),
      };
      lastExecution = Promise.resolve(execute({ writer })).then(async () => {
        await onFinish?.();
      });
      return { getReader: vi.fn() };
    }),
    createUIMessageStreamResponse: vi
      .fn()
      .mockReturnValue(
        new Response("{}", {
          headers: { "Content-Type": "text/event-stream" },
        }),
      ),
  };
});

vi.mock("@/shared/http-tool-calls", () => ({
  hasUnresolvedToolCalls: vi.fn().mockReturnValue(false),
  executeToolCallsFromMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock("../mcpjam-tool-helpers", () => ({
  serializeToolsForConvex: vi.fn(() => []),
}));

// The MCP-apps scrubbers walk the manager's real server list; the stub manager
// below has no such list, and this matrix is not about scrubbing.
vi.mock("../chat-helpers", async () => {
  const actual = await vi.importActual<typeof import("../chat-helpers")>(
    "../chat-helpers",
  );
  return {
    ...actual,
    scrubMcpAppsToolResultsForBackend: vi.fn((messages) => messages),
    scrubChatGPTAppsToolResultsForBackend: vi.fn((messages) => messages),
  };
});

vi.mock("../logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    systemEvent: vi.fn(),
    event: vi.fn(),
  },
  captureOriginErrorToSentry: vi.fn(),
}));

type Verdict = "gate" | "free";

/**
 * Drive ONE tool call through the MCPJam emulated loop and report whether the
 * user would see a pill.
 */
async function mcpjamVerdict(args: {
  name: string;
  input: Record<string, unknown>;
  tools: ToolSet;
  requireToolApproval: boolean;
  uiToolApprovals?: UiToolApprovalClassification | undefined;
  progressivePlan?: unknown;
}): Promise<Verdict> {
  writtenChunks = [];
  global.fetch = vi.fn().mockResolvedValue(
    createSseResponse([
      {
        type: "tool-input-available",
        toolCallId: "call-1",
        toolName: args.name,
        input: args.input,
      },
      { type: "finish", finishReason: "stop" },
    ]),
  );
  await handleMCPJamFreeChatModel({
    messages: [{ role: "user", content: "go" }] as any,
    modelId: "gpt-4.1-mini",
    systemPrompt: "You are helpful",
    tools: args.tools as any,
    mcpClientManager: {
      getAllToolsMetadata: vi.fn().mockReturnValue({}),
    } as any,
    requireToolApproval: args.requireToolApproval,
    ...(args.uiToolApprovals ? { uiToolApprovals: args.uiToolApprovals } : {}),
    ...(args.progressivePlan
      ? { progressivePlan: args.progressivePlan as any }
      : {}),
  });
  await lastExecution;
  return writtenChunks.some(
    (chunk: any) => chunk?.type === "tool-approval-request",
  )
    ? "gate"
    : "free";
}

/**
 * Read the declaration `streamText` reads. A function form is invoked with the
 * row's representative input, exactly as the AI SDK invokes it.
 */
async function byokVerdict(args: {
  name: string;
  input: Record<string, unknown>;
  tools: ToolSet;
}): Promise<Verdict> {
  const declared = (args.tools as Record<string, any>)[args.name]
    ?.needsApproval;
  const value =
    typeof declared === "function"
      ? await declared(args.input, {
          toolCallId: "call-1",
          messages: [],
        })
      : declared;
  return value === true ? "gate" : "free";
}

// ── family fixtures ────────────────────────────────────────────────────────

const noopRunner = vi.fn() as never;

function fakeBrowserSession() {
  return vi.fn(
    async () =>
      ({
        engine: "hosted" as const,
        target: "computer" as const,
        sessionId: "session-1",
        computerId: "computer-1",
        bootId: "boot-1",
        client: { sendCommand: vi.fn() } as never,
        streamUrl: "https://stream.example/vnc.html",
        streamPassword: "pw",
        contextMode: "persistent",
        reused: true,
      } as BrowserSessionHandle),
  );
}

const UI_DESTRUCTIVE = {
  name: "ui_execute_tool",
  description: "Run a tool",
  readOnly: false,
  annotations: { readOnlyHint: false, destructiveHint: true },
} as const;
const UI_READ_ONLY = {
  name: "ui_snapshot_app",
  description: "Look",
  readOnly: true,
  annotations: { readOnlyHint: true, destructiveHint: false },
} as const;
const UI_OTHER = {
  name: "ui_navigate",
  description: "Go somewhere",
  readOnly: false,
  annotations: { readOnlyHint: false, destructiveHint: false },
} as const;

const PROGRESSIVE_PLAN = {
  enabled: true as const,
  reasons: ["matrix"],
  policy: {
    thresholdPct: 0.03,
    maxToolTokens: 10_000,
    maxToolCount: 30,
    searchLimit: 8,
  },
  catalog: [],
  totalTokenEstimate: 0,
};

const SERVER_SKILL_REF = "acme/refunds";

function effectiveSkillTools(opts: { serverOrigin: boolean }) {
  return createEffectiveSkillTools({
    skills: [
      {
        ref: SERVER_SKILL_REF,
        skillId: "sk_1",
        name: "refunds",
        description: "Refunds",
        content: "BODY",
        aggregateHash: "agg_1",
        files: [],
        serverId: "srv_1",
        serverLabel: "Acme",
        skillUri: "skill://acme/refunds",
        versionId: "v1",
        versionNumber: 1,
        capturedAt: 1,
      } as never,
    ],
    pluginRefs: new Set<string>(),
    serverRefs: opts.serverOrigin
      ? new Set([SERVER_SKILL_REF])
      : new Set<string>(),
  }) as unknown as ToolSet;
}

interface MatrixRow {
  family: string;
  /** The name the model calls. */
  name: string;
  /** Representative input — what a function-form declaration is handed. */
  input?: Record<string, unknown>;
  /** This family's advertised toolset, for the turn's switch state. */
  tools: (requireToolApproval: boolean) => ToolSet;
  /**
   * What the production route threads into the MCPJam engine's name-keyed
   * `uiToolApprovals` slot for this family.
   *
   * DELETED IN PR 2 — the whole field, on every row. Until then it is what
   * makes the `mcpjam` column reflect production rather than a shape no route
   * actually sends.
   */
  uiToolApprovals?: (
    requireToolApproval: boolean,
  ) => UiToolApprovalClassification;
  /** Set on the one family that exists only under progressive discovery. */
  progressivePlan?: unknown;
  expected: {
    mcpjam: { on: Verdict; off: Verdict };
    byok: { on: Verdict; off: Verdict };
  };
  /** Why the two engines disagree, for the rows where they do. */
  divergence?: string;
}

const MATRIX: MatrixRow[] = [
  {
    // Floor: setting. `mcpToolOptionsFor({needsApproval})` is the one place a
    // real MCP tool's declaration is decided; the SDK stamps it onto every
    // tool it enumerates.
    family: "real MCP tool",
    name: "list_issues",
    tools: (flag) => ({
      list_issues: {
        description: "List issues",
        inputSchema: { type: "object" } as never,
        execute: async () => ({}),
        ...(mcpToolOptionsFor({ needsApproval: flag })?.needsApproval
          ? { needsApproval: true }
          : {}),
      } as never,
    }),
    expected: {
      mcpjam: { on: "gate", off: "free" },
      byok: { on: "gate", off: "free" },
    },
  },
  {
    // Floor: setting.
    family: "hosted bash",
    name: "bash",
    input: { command: "ls" },
    tools: (flag) => ({
      bash: buildBashTool(
        {
          authHeader: "Bearer u",
          projectId: "proj_1",
          engine: "e2b",
          requireToolApproval: flag,
        },
        noopRunner,
      ),
    }),
    expected: {
      mcpjam: { on: "gate", off: "free" },
      byok: { on: "gate", off: "free" },
    },
  },
  {
    // Floor: setting.
    family: "sandbox bash",
    name: "bash",
    input: { command: "ls" },
    tools: (flag) => ({
      bash: buildSandboxBashTool(
        { sandboxId: "sbx_1", requireToolApproval: flag },
        noopRunner,
      ),
    }),
    expected: {
      mcpjam: { on: "gate", off: "free" },
      byok: { on: "gate", off: "free" },
    },
  },
  {
    // Floor: always — a model-driven shell on the user's own machine has no
    // auto-approve in v1, "whatever the host config says" (bash.ts).
    family: "local bash",
    name: "bash",
    input: { command: "ls" },
    tools: (flag) => ({
      bash: buildBashTool(
        {
          authHeader: "Bearer u",
          projectId: "proj_1",
          engine: "local",
          requireToolApproval: flag,
        },
        noopRunner,
      ),
    }),
    expected: {
      mcpjam: { on: "gate", off: "free" }, // DIVERGENCE — flipped in PR 2
      byok: { on: "gate", off: "gate" },
    },
    divergence:
      "bash.ts declares `needsApproval: true` for the local engine, but the " +
      "MCPJam engine never reads it and `bash` is in no name set — so with " +
      "the switch off a real shell on the user's real machine runs with no " +
      "pill. PR 2 flips mcpjam.off to `gate`.",
  },
  {
    // Floor: setting. Opens an ephemeral connection to a user's saved server.
    family: "workspace tool — connection-opening",
    name: "diagnose_server",
    tools: (flag) => ({
      diagnose_server: buildMcpjamTool("diagnose_server", {
        client: {} as never,
        projectId: "proj_1",
        requireToolApproval: flag,
      })!,
    }),
    expected: {
      mcpjam: { on: "gate", off: "free" },
      byok: { on: "gate", off: "free" },
    },
  },
  {
    // Floor: never. `mcpjam.ts` gates only APPROVAL_REQUIRED_IDS, and
    // `docs/inspector/playground.mdx` promises read-only listing tools never
    // ask.
    family: "workspace tool — platform read",
    name: "list_project_servers",
    tools: (flag) => ({
      list_project_servers: buildMcpjamTool("list_project_servers", {
        client: {} as never,
        projectId: "proj_1",
        requireToolApproval: flag,
      })!,
    }),
    expected: {
      mcpjam: { on: "gate", off: "free" }, // DIVERGENCE — flipped in PR 2
      byok: { on: "free", off: "free" },
    },
    divergence:
      "The MCPJam engine classifies an unknown name by the switch alone, so " +
      "with the switch on every workspace tool gates — reads included, " +
      "against both `mcpjam.ts`'s own rule and the playground doc. PR 2 " +
      "flips mcpjam.on to `free`.",
  },
  {
    // Floor: always. Destructive wins over the switch in both directions.
    family: "ui_* destructive",
    name: UI_DESTRUCTIVE.name,
    tools: (flag) =>
      buildUiTools([UI_DESTRUCTIVE] as never, {
        requireToolApproval: flag,
      }),
    uiToolApprovals: (flag) =>
      classifyUiToolApprovals([UI_DESTRUCTIVE] as never, flag),
    expected: {
      mcpjam: { on: "gate", off: "gate" },
      byok: { on: "gate", off: "gate" },
    },
  },
  {
    // Floor: never. Observing buys no safety by pausing and costs a click.
    family: "ui_* read-only",
    name: UI_READ_ONLY.name,
    tools: (flag) =>
      buildUiTools([UI_READ_ONLY] as never, {
        requireToolApproval: flag,
      }),
    uiToolApprovals: (flag) =>
      classifyUiToolApprovals([UI_READ_ONLY] as never, flag),
    expected: {
      mcpjam: { on: "free", off: "free" },
      byok: { on: "free", off: "free" },
    },
  },
  {
    // Floor: setting.
    family: "ui_* other",
    name: UI_OTHER.name,
    tools: (flag) =>
      buildUiTools([UI_OTHER] as never, {
        requireToolApproval: flag,
      }),
    uiToolApprovals: (flag) =>
      classifyUiToolApprovals([UI_OTHER] as never, flag),
    expected: {
      mcpjam: { on: "gate", off: "free" },
      byok: { on: "gate", off: "free" },
    },
  },
  {
    // Floor: always. Third-party code in a browser that is signed into things,
    // and the page's own annotations are claims by the party whose code runs.
    family: "page_*",
    name: "page_ab12cd34",
    tools: () =>
      buildPageTools([
        {
          alias: "page_ab12cd34",
          sessionId: "sess_1",
          toolKey: "https://shop.test::checkout",
          rawName: "checkout",
          origin: "https://shop.test",
          description: "Check out",
        },
      ] as never),
    uiToolApprovals: () => classifyPageToolApprovals(["page_ab12cd34"]),
    expected: {
      mcpjam: { on: "gate", off: "gate" },
      byok: { on: "gate", off: "gate" },
    },
  },
  {
    // Floor: always.
    family: "browser_* attested",
    name: "browser_act",
    tools: () =>
      buildBrowserTools({
        authHeader: "Bearer u",
        projectId: "proj_1",
        approvalDelivery: { kind: "attested" },
        ensureSession: fakeBrowserSession() as never,
      })!.tools,
    uiToolApprovals: () =>
      classifyBrowserToolApprovals(
        Object.keys(
          buildBrowserTools({
            authHeader: "Bearer u",
            projectId: "proj_1",
            approvalDelivery: { kind: "attested" },
            ensureSession: fakeBrowserSession() as never,
          })!.tools,
        ),
        { readOnly: false },
      ),
    expected: {
      mcpjam: { on: "gate", off: "gate" },
      byok: { on: "gate", off: "gate" },
    },
  },
  {
    // Floor: never. An unattended read-only run builds ONLY the tools that
    // look — refusing to build the rest is stronger than gating them, since
    // there is nobody to ask.
    family: "browser_* unattended read-only observation",
    name: "browser_observe",
    tools: () =>
      buildBrowserTools({
        authHeader: "Bearer u",
        projectId: "proj_1",
        engine: "local",
        runKey: "run-1",
        approvalDelivery: {
          kind: "unattended",
          policy: { mode: "read_only" },
        },
        ensureSession: fakeBrowserSession() as never,
      })!.tools,
    uiToolApprovals: () =>
      classifyBrowserToolApprovals(
        ["browser_observe", "browser_webmcp_tools"],
        { readOnly: true },
      ),
    expected: {
      mcpjam: { on: "free", off: "free" },
      byok: { on: "free", off: "free" },
    },
  },
  {
    // Floor: always. Same rule as local bash, same reason.
    family: "browser_* local",
    name: "browser_act",
    tools: () =>
      buildBrowserTools({
        authHeader: "Bearer u",
        projectId: "proj_1",
        engine: "local",
        approvalDelivery: { kind: "attested" },
        ensureSession: fakeBrowserSession() as never,
      })!.tools,
    uiToolApprovals: () =>
      classifyBrowserToolApprovals(
        Object.keys(
          buildBrowserTools({
            authHeader: "Bearer u",
            projectId: "proj_1",
            engine: "local",
            approvalDelivery: { kind: "attested" },
            ensureSession: fakeBrowserSession() as never,
          })!.tools,
        ),
        { readOnly: false },
      ),
    expected: {
      mcpjam: { on: "gate", off: "gate" },
      byok: { on: "gate", off: "gate" },
    },
  },
  {
    // Floor: never. Gating discovery itself behind N approvals defeats it.
    family: "progressive meta-tool",
    name: "search_mcp_tools",
    input: { query: "issues" },
    progressivePlan: PROGRESSIVE_PLAN,
    tools: () =>
      createProgressiveMetaTools({
        getCatalog: () => [],
        state: {
          loadedToolIds: new Set(),
          newlyLoadedToolIds: new Set(),
        } as never,
        policy: PROGRESSIVE_PLAN.policy as never,
      }),
    expected: {
      mcpjam: { on: "free", off: "free" },
      byok: { on: "free", off: "free" },
    },
  },
  {
    // Floor: never. Pure reads of frozen content under an auto-deny eval run,
    // where a prompt is a hang rather than a question.
    family: "pinned skill tool",
    name: "loadSkill",
    input: { name: "pdf-processing" },
    tools: (flag) =>
      applySkillToolApproval(
        createPinnedSkillTools([
          {
            name: "pdf-processing",
            description: "PDFs",
            content: "BODY",
          } as never,
        ]) as unknown as Record<string, unknown>,
        { pinned: true, requireToolApproval: flag },
      ) as unknown as ToolSet,
    expected: {
      mcpjam: { on: "gate", off: "free" }, // DIVERGENCE — flipped in PR 2
      byok: { on: "free", off: "free" },
    },
    divergence:
      "`applySkillToolApproval` leaves a pinned skill tool with no " +
      "declaration at all, which is how it says `never` — and the MCPJam " +
      'engine reads a name it does not know as "follow the switch". An eval ' +
      "run with the switch on is auto-deny, so the pill it pauses for is " +
      "answered `no` and the skill never loads. PR 2 flips mcpjam.on to " +
      "`free`.",
  },
  {
    // Floor: setting.
    family: "computer skill tool",
    name: "loadSkill",
    input: { name: SERVER_SKILL_REF },
    tools: (flag) =>
      applySkillToolApproval(
        effectiveSkillTools({ serverOrigin: false }) as unknown as Record<
          string,
          unknown
        >,
        { pinned: false, requireToolApproval: flag },
      ) as unknown as ToolSet,
    expected: {
      mcpjam: { on: "gate", off: "free" },
      byok: { on: "gate", off: "free" },
    },
  },
  {
    // Floor: always, and a FUNCTION rather than `true` — SEP-2640 binds host
    // trust to a digest set that has to be resolved before the prompt.
    family: "server-origin skill ref",
    name: "loadSkill",
    input: { name: SERVER_SKILL_REF },
    tools: (flag) =>
      applySkillToolApproval(
        effectiveSkillTools({ serverOrigin: true }) as unknown as Record<
          string,
          unknown
        >,
        { pinned: false, requireToolApproval: flag },
      ) as unknown as ToolSet,
    expected: {
      mcpjam: { on: "gate", off: "free" }, // DIVERGENCE — flipped in PR 2
      byok: { on: "gate", off: "gate" },
    },
    divergence:
      "The server-origin declaration is a function; the MCPJam engine never " +
      "invokes it, so with the switch off a third party's instructions enter " +
      "the turn with no pill and no digest binding. PR 2 flips mcpjam.off to " +
      "`gate`.",
  },
  {
    // Floor: never — never set on this family.
    family: "app_*",
    name: "app_ab12cd34",
    tools: () =>
      buildAppTools([
        {
          alias: "app_ab12cd34",
          appName: "Acme",
          rawName: "search",
          description: "Search",
        },
      ] as never),
    expected: {
      mcpjam: { on: "gate", off: "free" }, // DIVERGENCE — flipped in PR 2
      byok: { on: "free", off: "free" },
    },
    divergence:
      '`buildAppTools` deliberately sets nothing ("normal server-tool ' +
      'approval remains scoped to server tools"), and the MCPJam engine ' +
      "reads that silence as the switch. PR 2 flips mcpjam.on to `free`.",
  },
  {
    // Floor: never — never set on this family.
    family: "exa web search",
    name: "web_search",
    input: { query: "mcp" },
    tools: () => ({
      web_search: buildExaWebSearchTool({
        authHeader: "Bearer u",
        projectId: "proj_1",
      } as never),
    }),
    expected: {
      mcpjam: { on: "gate", off: "free" }, // DIVERGENCE — flipped in PR 2
      byok: { on: "free", off: "free" },
    },
    divergence:
      "Same silence as `app_*`: the builder sets no declaration, and only " +
      "the MCPJam engine turns that into a pill. PR 2 flips mcpjam.on to " +
      "`free`.",
  },
];

describe("tool approval matrix — family × engine × switch", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    lastExecution = null;
    writtenChunks = [];
    process.env.CONVEX_HTTP_URL = "https://test-convex.example.com";
    vi.mocked(hasUnresolvedToolCalls).mockReturnValue(false);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CONVEX_HTTP_URL;
  });

  for (const row of MATRIX) {
    for (const flag of [true, false]) {
      const label = flag ? "on" : "off";

      it(`${row.family} · mcpjam · switch ${label} → ${row.expected.mcpjam[label]}`, async () => {
        const verdict = await mcpjamVerdict({
          name: row.name,
          input: row.input ?? {},
          tools: row.tools(flag),
          requireToolApproval: flag,
          uiToolApprovals: row.uiToolApprovals?.(flag),
          progressivePlan: row.progressivePlan,
        });
        expect(verdict, row.divergence ?? row.family).toBe(
          row.expected.mcpjam[label],
        );
      });

      it(`${row.family} · byok · switch ${label} → ${row.expected.byok[label]}`, async () => {
        const verdict = await byokVerdict({
          name: row.name,
          input: row.input ?? {},
          tools: row.tools(flag),
        });
        expect(verdict, row.divergence ?? row.family).toBe(
          row.expected.byok[label],
        );
      });
    }
  }
});

/**
 * Every row above where the engines disagree, restated as one list.
 *
 * Not redundant with the rows: this is the review gate. PR 2's diff to this
 * file must be exactly these rows plus the `uiToolApprovals` field, and a
 * SEVENTH entry appearing here means a family stopped filling both channels
 * after the mechanism was supposed to be singular.
 */
describe("known divergences", () => {
  it("names exactly six, and each says which engine is wrong", () => {
    const diverging = MATRIX.filter((row) => row.divergence);
    expect(diverging.map((row) => row.family)).toEqual([
      "local bash",
      "workspace tool — platform read",
      "pinned skill tool",
      "server-origin skill ref",
      "app_*",
      "exa web search",
    ]);
    for (const row of diverging) {
      expect(
        row.expected.mcpjam.on !== row.expected.byok.on ||
          row.expected.mcpjam.off !== row.expected.byok.off,
        `${row.family} is marked as diverging but both engines agree`,
      ).toBe(true);
    }
  });
});

/**
 * The MCPJam gate's own contract, asserted directly rather than through a turn.
 *
 * The rows above are the behaviour; this is the rule that produces it. Keeping
 * both means a change to the predicate that happens to leave one row's verdict
 * intact still shows up here.
 */
describe("toolCallNeedsApproval — the MCPJam gate", () => {
  const classification = classifyUiToolApprovals(
    [UI_DESTRUCTIVE, UI_READ_ONLY] as never,
    false,
  );

  it("lets the name set win over the switch, in both directions", () => {
    expect(
      toolCallNeedsApproval(
        UI_DESTRUCTIVE.name,
        undefined,
        classification,
        false,
      ),
    ).toBe(true);
    expect(
      toolCallNeedsApproval(UI_READ_ONLY.name, undefined, classification, true),
    ).toBe(false);
  });

  it("follows the switch for a name it does not know", () => {
    expect(
      toolCallNeedsApproval("list_issues", undefined, classification, true),
    ).toBe(true);
    expect(
      toolCallNeedsApproval("list_issues", undefined, classification, false),
    ).toBe(false);
  });

  it("exempts meta-tools ONLY while progressive discovery is on", () => {
    expect(
      toolCallNeedsApproval(
        "search_mcp_tools",
        PROGRESSIVE_PLAN as never,
        undefined,
        true,
      ),
    ).toBe(false);
    // Progressive off ⇒ no meta-tools exist, and a real server is free to
    // expose a tool by that name. Honoring the exemption would run it unasked.
    expect(
      toolCallNeedsApproval("search_mcp_tools", undefined, undefined, true),
    ).toBe(true);
  });

  it("coerces an absent switch to a real boolean", () => {
    expect(
      toolCallNeedsApproval("list_issues", undefined, undefined, undefined),
    ).toBe(false);
  });
});
