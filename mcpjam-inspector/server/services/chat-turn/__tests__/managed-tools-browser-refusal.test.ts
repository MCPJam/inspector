import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const m = vi.hoisted(() => ({
  hosted: true,
  refused: false,
  exposable: true as boolean | null,
  stale: false,
  provision: vi.fn(),
}));
vi.mock("../../../config.js", async (original) => ({
  ...(await original<typeof import("../../../config.js")>()),
  get HOSTED_MODE() {
    return m.hosted;
  },
}));
vi.mock("../../../utils/computers/control-plane-client.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/computers/control-plane-client.js")
  >()),
  provisionPlaygroundTerminalSandbox: m.provision,
  isComputersDataPlaneConfigured: () => true,
  touchSandbox: vi.fn(async () => "touched"),
}));
vi.mock("../../../utils/computers/runtime-config.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/computers/runtime-config.js")
  >()),
  isHostedBrowserRefused: () => m.refused,
  isHostedBrowserExposable: () => m.exposable,
  isHostedBrowserVerdictStale: () => m.stale,
}));
vi.mock("../../browserd/page-tools-peek.js", async (original) => ({
  ...(await original<typeof import("../../browserd/page-tools-peek.js")>()),
  peekPageToolsForChatTurn: async () => undefined,
}));
vi.mock("../../../utils/harness/runtime-secrets.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/harness/runtime-secrets.js")
  >()),
  fetchRuntimeSecrets: async () => ({ ok: true, secrets: [] }),
}));
vi.mock("../../../utils/computers/environment-context.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/computers/environment-context.js")
  >()),
  maybeAppendEnvironmentContext: async (args: { systemPrompt?: string }) =>
    args.systemPrompt,
}));
vi.mock("../../../routes/web/mcpjam-platform-client.js", () => ({
  buildMcpjamPlatformClient: () => undefined,
}));

import { prepareManagedTools } from "../managed-tools.js";
import { TurnResources } from "../resources.js";
import { BROWSER_REFUSAL_MODEL_CONTEXT } from "../../../utils/built-in-tools/browser-refusal.js";

type Setup = Parameters<typeof prepareManagedTools>[0]["setup"];

const TERMINAL_ONLY =
  "Browser is unavailable on this conversation's computer for this turn. " +
  "If asked to open an app, explain that. Don't run xdg-open or launch a " +
  "desktop browser; headless checks in the terminal are fine. Don't present " +
  "the computer's localhost URL as a link the user can open.";

async function runTurn(args: {
  harness?: "claude-code" | "codex";
  pinned?: boolean;
  compare?: boolean;
  tools?: string[];
  chatSessionId?: string;
}) {
  const chatSessionId = args.chatSessionId ?? "chat-1";
  const setup = {
    hostedBody: {
      projectId: "project-1",
      chatSessionId,
      ...(args.compare ? { comparePane: true } : {}),
    },
    body: { chatSessionId, browserScope: "conversation" },
    turnMode: "interactive",
    pinsEnvironment: args.pinned === true,
    ...(args.pinned
      ? {
          environmentSpec: {
            environmentRef: { environmentId: "pinned-env" },
            host: { hostId: "host-1" },
          },
        }
      : {}),
    resolvedExecution: args.harness ? { harness: args.harness } : {},
    builtInToolPolicy: {},
    turnBuiltInToolIds: args.tools ?? ["browser", "bash"],
    requireToolApproval: true,
    scenarioParticipant: false,
    localBrowserSettingsUnavailable: false,
    systemPrompt: "Baseline",
  } as unknown as Setup;
  const app = new Hono();
  let result: Awaited<ReturnType<typeof prepareManagedTools>> | undefined;
  app.post("/", async (c) => {
    result = await prepareManagedTools({
      c,
      rawBody: {},
      bearerToken: "test-only",
      localIngress: false,
      resources: new TurnResources(() => {}),
      setup,
      connections: { validatedPageTools: [] },
    });
    await result.scenarioBox?.release();
    return c.json({});
  });
  expect((await app.request("/", { method: "POST" })).status).toBe(200);
  return {
    tools: Object.keys(result!.builtInTools ?? {}).sort(),
    prompt: result!.effectiveSystemPrompt,
    notices: result!.sandboxNotices ?? [],
  };
}

describe("Browser on for the client and missing from the turn", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network disabled in this test");
      }),
    );
    m.hosted = true;
    m.refused = false;
    m.exposable = true;
    m.stale = false;
    m.provision.mockReset();
    m.provision.mockResolvedValue({
      ok: true,
      value: {
        sandboxId: "workspace",
        sandboxRowId: "row",
        workdir: "/home/user",
      },
    });
  });

  it.each([
    ["pinned", true],
    ["unpinned", false],
  ])(
    "tells a %s cloud harness turn why, with no notice",
    async (_label, pinned) => {
      const turn = await runTurn({ harness: "claude-code", pinned });
      expect(turn.tools).toEqual(["bash"]);
      expect(turn.prompt).toBe(`Baseline\n\n## Browser\n\n${TERMINAL_ONLY}`);
      expect(turn.notices).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("decides each compare column from its own turn", async () => {
    const withBrowser = await runTurn({
      harness: "codex",
      compare: true,
      chatSessionId: "column-a",
    });
    const withoutBrowser = await runTurn({
      harness: "claude-code",
      compare: true,
      chatSessionId: "column-b",
      tools: ["bash"],
    });
    expect(withBrowser.prompt).toBe(
      `Baseline\n\n## Browser\n\n${TERMINAL_ONLY}`,
    );
    expect(withoutBrowser.prompt).toBe("Baseline");
    expect(withBrowser.notices).toEqual([]);
    expect(withoutBrowser.notices).toEqual([]);
  });

  it("says nothing on an ordinary turn with Browser off", async () => {
    const turn = await runTurn({ harness: "claude-code", tools: ["bash"] });
    expect(turn.tools).toEqual(["bash"]);
    expect(turn.prompt).toBe("Baseline");
    expect(turn.notices).toEqual([]);
  });

  it("says nothing when the browser is advertised", async () => {
    const turn = await runTurn({ tools: ["browser"] });
    expect(turn.tools.some((name) => name.startsWith("browser_"))).toBe(true);
    expect(turn.prompt).toBe("Baseline");
  });

  it.each([
    {
      label: "a stale verdict on mcpjam.com",
      hosted: true,
      exposable: null,
      stale: true,
      reason: "cloud_browser_unavailable" as const,
    },
    {
      label: "no verdict yet on mcpjam.com",
      hosted: true,
      exposable: null,
      stale: false,
      reason: "cloud_browser_unavailable" as const,
    },
    {
      label: "an unconfigured runtime on mcpjam.com",
      hosted: true,
      exposable: false,
      stale: false,
      reason: "cloud_browser_not_configured" as const,
    },
    {
      label: "an unconfigured self-hosted installation",
      hosted: false,
      exposable: false,
      stale: false,
      reason: "cloud_browser_unavailable_installation" as const,
    },
  ])(
    "explains $label to the model",
    async ({ hosted, exposable, stale, reason }) => {
      m.hosted = hosted;
      m.refused = true;
      m.exposable = exposable;
      m.stale = stale;
      const turn = await runTurn({ tools: ["browser"] });
      expect(turn.tools).toEqual([]);
      expect(turn.prompt).toBe(
        `Baseline\n\n## Browser\n\n${BROWSER_REFUSAL_MODEL_CONTEXT[reason]}`,
      );
      expect(turn.notices).toEqual([]);
    },
  );
});
