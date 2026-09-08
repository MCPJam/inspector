/**
 * THE approval matrix: family × engine × switch → gate | free.
 *
 * Approval is declared ONCE, on the tool, and every engine reads that one
 * declaration. This file is where the answer lives: every row states the
 * family, what its builder produces, and what each engine then does with the
 * switch on and off.
 *
 * It exists because there used to be TWO channels — `tool.needsApproval`,
 * which only the BYOK `streamText` path read, and a per-turn set of tool NAMES
 * the route threaded, which only the MCPJam loop read. A family that filled one
 * and not the other was silently wrong on the other engine, in six places, and
 * nothing said so. The columns below are no longer allowed to disagree, and
 * that is the property this table is for.
 *
 * HOW EACH ENGINE IS DRIVEN — deliberately not a shared abstraction over the
 * two, because they remain different readers of the same fact:
 *
 *   - `mcpjam` runs a whole turn through `handleMCPJamFreeChatModel` with a
 *     fake model emitting one `tool-call`, and asks whether a
 *     `tool-approval-request` chunk followed. That is the user-visible pill.
 *   - `byok` evaluates `tools[name].needsApproval` — the value `streamText`
 *     reads — invoking it with a representative input when it is a function.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import { hasUnresolvedToolCalls } from "@/shared/http-tool-calls";
import {
  createApprovalDecisionCache,
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
    createUIMessageStreamResponse: vi.fn().mockReturnValue(
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
  /** Set on the one family that exists only under progressive discovery. */
  progressivePlan?: unknown;
  expected: {
    mcpjam: { on: Verdict; off: Verdict };
    byok: { on: Verdict; off: Verdict };
  };
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
      mcpjam: { on: "gate", off: "gate" },
      byok: { on: "gate", off: "gate" },
    },
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
      mcpjam: { on: "free", off: "free" },
      byok: { on: "free", off: "free" },
    },
  },
  {
    // Floor: always. Destructive wins over the switch in both directions.
    family: "ui_* destructive",
    name: UI_DESTRUCTIVE.name,
    tools: (flag) =>
      buildUiTools([UI_DESTRUCTIVE] as never, {
        requireToolApproval: flag,
      }),
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
      mcpjam: { on: "free", off: "free" },
      byok: { on: "free", off: "free" },
    },
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
      mcpjam: { on: "gate", off: "gate" },
      byok: { on: "gate", off: "gate" },
    },
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
      mcpjam: { on: "free", off: "free" },
      byok: { on: "free", off: "free" },
    },
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
      mcpjam: { on: "free", off: "free" },
      byok: { on: "free", off: "free" },
    },
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
          progressivePlan: row.progressivePlan,
        });
        expect(verdict, row.family).toBe(row.expected.mcpjam[label]);
      });

      it(`${row.family} · byok · switch ${label} → ${row.expected.byok[label]}`, async () => {
        const verdict = await byokVerdict({
          name: row.name,
          input: row.input ?? {},
          tools: row.tools(flag),
        });
        expect(verdict, row.family).toBe(row.expected.byok[label]);
      });
    }
  }
});

/**
 * THE PROPERTY, stated once: the two engines never disagree.
 *
 * This replaces the divergence list the table carried while there were two
 * channels. It named six rows where one engine could not see a family's
 * declaration; the fix was to delete the second channel, so what used to be a
 * list of known exceptions is now an invariant with no exceptions.
 *
 * Both checks below run the REAL builders and the REAL engines. Comparing the
 * two `expected` columns against each other instead would have been a check on
 * this file's own fixture — it would catch a typo in the table and nothing
 * else, while reading like the guarantee the change exists to make.
 */
describe("one mechanism", () => {
  for (const row of MATRIX) {
    for (const flag of [true, false]) {
      const label = flag ? "on" : "off";

      it(`${row.family} · switch ${label} → both engines answer the same`, async () => {
        // A FRESH toolset per engine, as production gives each turn. Sharing
        // one would hand the same function-form declaration to two readers
        // under the same `toolCallId`, and a second evaluation of the SEP-2640
        // gate re-fetches the manifest and can overwrite the binding it exists
        // to check — the hazard the memoisation test next door is about.
        const [mcpjam, byok] = [
          await mcpjamVerdict({
            name: row.name,
            input: row.input ?? {},
            tools: row.tools(flag),
            requireToolApproval: flag,
            progressivePlan: row.progressivePlan,
          }),
          await byokVerdict({
            name: row.name,
            input: row.input ?? {},
            tools: row.tools(flag),
          }),
        ];
        expect(mcpjam, `${row.family}: mcpjam vs byok`).toBe(byok);
      });
    }
  }

  it("never lets the switch FREE a family that asks without it", async () => {
    // The floor semantics, off the built tools rather than off the table: the
    // switch raises. A family that gates with the switch off and not with it
    // on would be a setting that turns safety down.
    for (const row of MATRIX) {
      const ask = (flag: boolean) =>
        byokVerdict({
          name: row.name,
          input: row.input ?? {},
          tools: row.tools(flag),
        });
      const [on, off] = [await ask(true), await ask(false)];
      expect(
        on === "gate" || off === "free",
        `${row.family} stops asking when the switch is turned on`,
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
  const ask = (
    name: string,
    tools: Record<string, unknown>,
    over: {
      toolCallId?: string;
      decisions?: ReturnType<typeof createApprovalDecisionCache>;
    } = {},
  ) =>
    toolCallNeedsApproval({
      name,
      input: { name: "acme/refunds" },
      toolCallId: over.toolCallId ?? "call-1",
      tools: tools as never,
      messages: [],
      decisions: over.decisions ?? createApprovalDecisionCache(),
    });

  it("reads the tool's declaration, not the turn's switch", async () => {
    const tools = {
      gated: { needsApproval: true },
      free: { needsApproval: false },
    };
    expect(await ask("gated", tools)).toBe(true);
    expect(await ask("free", tools)).toBe(false);
  });

  it("treats a MISSING declaration as free, the way the AI SDK does", async () => {
    // `never` spelled as silence. The two readers must agree here or a turn
    // strands: the client defers on one answer while the server sends the
    // other.
    expect(await ask("undeclared", { undeclared: {} })).toBe(false);
    expect(await ask("absent", {})).toBe(false);
  });

  it("invokes a FUNCTION declaration the way streamText does", async () => {
    const seen: unknown[] = [];
    const tools = {
      loadSkill: {
        needsApproval: (input: unknown, options: unknown) => {
          seen.push({ input, options });
          return true;
        },
      },
    };
    expect(await ask("loadSkill", tools)).toBe(true);
    expect(seen).toEqual([
      {
        input: { name: "acme/refunds" },
        options: { toolCallId: "call-1", messages: [] },
      },
    ]);
  });

  it("evaluates a function ONCE per tool call, however often it is asked", async () => {
    // Not an optimization. The SEP-2640 declaration RECORDS the manifest
    // digest `execute` re-checks, and this engine asks about the same call
    // three times (emit gate, unresolved re-scan, auto-deny re-scan). A second
    // evaluation would re-fetch the manifest and could overwrite the binding
    // it exists to check.
    let calls = 0;
    const tools = {
      loadSkill: {
        needsApproval: async () => {
          calls += 1;
          return true;
        },
      },
    };
    const decisions = createApprovalDecisionCache();
    await Promise.all([
      ask("loadSkill", tools, { decisions }),
      ask("loadSkill", tools, { decisions }),
    ]);
    await ask("loadSkill", tools, { decisions });
    expect(calls).toBe(1);
    // A DIFFERENT call is a different question.
    await ask("loadSkill", tools, { decisions, toolCallId: "call-2" });
    expect(calls).toBe(2);
  });

  it("fails CLOSED on a declaration that is neither boolean nor function", async () => {
    // Out of contract — the AI SDK would try to CALL it and throw. A bug to
    // fix, not a tool to wave through.
    expect(
      await ask("weird", { weird: { needsApproval: "yes" as never } }),
    ).toBe(true);
  });

  it("fails CLOSED when a function declaration throws", async () => {
    const tools = {
      loadSkill: {
        needsApproval: () => {
          throw new Error("server unreachable");
        },
      },
    };
    expect(await ask("loadSkill", tools)).toBe(true);
  });

  it("does not exempt meta-tools by NAME", async () => {
    // Progressive mode mints them with a `never` declaration, so they are free
    // because of what they carry. A REAL server tool that happens to be called
    // `search_mcp_tools` carries the switch's declaration and still asks —
    // which is what the old name-plus-plan exemption was protecting, now for
    // free.
    expect(
      await ask("search_mcp_tools", {
        search_mcp_tools: { needsApproval: false },
      }),
    ).toBe(false);
    expect(
      await ask("search_mcp_tools", {
        search_mcp_tools: { needsApproval: true, execute: async () => ({}) },
      }),
    ).toBe(true);
  });
});
