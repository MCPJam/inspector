/**
 * `buildBrowserTools` — the two structural guarantees, plus the policy matrix.
 *
 *   1. FAIL-CLOSED: no attested approval path ⇒ no tools at all. This is what
 *      keeps the five `prepareChatV2` call sites that thread nothing (Slack
 *      agent, chat-session-turn, sessionSimulation runner, evals-runner ×2)
 *      and the `runAssistantTurn` eval path safe WITHOUT editing them.
 *   2. BOTH LAYERS: a daemon reply can be rejected (transport status) or fail
 *      in the browser (`result.ok === false`); a caller reading only the first
 *      would report a failed act as success.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildBrowserTools,
  BROWSER_BUILT_IN_TOOL_ID,
} from "../browser";
import type { BrowserSessionHandle } from "../../../services/browserd/browser-session";

type SendResult = {
  status: string;
  result?: {
    ok: boolean;
    output?: unknown;
    error?: string;
    stateToken?: unknown;
    settled?: boolean;
  };
  bootId?: string;
};

function fakeSession(send: (command: any) => Promise<SendResult>) {
  const sendCommand = vi.fn(async (command: any) => send(command));
  const ensureSession = vi.fn(
    async (): Promise<BrowserSessionHandle> =>
      ({
        sessionId: "session-1",
        computerId: "computer-1",
        bootId: "boot-1",
        client: { sendCommand } as never,
        streamUrl: "https://stream.example/vnc.html",
        streamPassword: "pw",
        contextMode: "persistent",
        reused: true,
      }) as BrowserSessionHandle,
  );
  return { ensureSession, sendCommand };
}

const OK: SendResult = {
  status: "ok",
  result: {
    ok: true,
    output: { url: "https://example.com", screenshot: "PNG" },
    stateToken: { tabId: "@session", navCounter: 1, urlHash: "u", domHash: "d" },
    settled: true,
  },
};

function build(
  over: Partial<Parameters<typeof buildBrowserTools>[0]> = {},
  send: (command: any) => Promise<SendResult> = async () => OK,
) {
  const fake = fakeSession(send);
  const result = buildBrowserTools({
    authHeader: "Bearer user",
    projectId: "project-1",
    approvalDelivery: { kind: "attested" },
    ensureSession: fake.ensureSession,
    ...over,
  });
  return { result, ...fake };
}

async function run(tools: any, name: string, args: Record<string, unknown>) {
  return tools[name].execute(args, { toolCallId: "call-1" });
}

describe("buildBrowserTools — fail-closed advertisement", () => {
  it("advertises NOTHING when the surface did not attest approval delivery", () => {
    const suppressed: Array<{ id: string; reason: string }> = [];
    const built = buildBrowserTools({
      authHeader: "Bearer user",
      projectId: "project-1",
      onToolSuppressed: (info) => suppressed.push(info),
    });
    expect(built).toBeUndefined();
    expect(suppressed[0]).toMatchObject({ id: BROWSER_BUILT_IN_TOOL_ID });
    expect(suppressed[0].reason).toContain("approval");
  });

  it("advertises the six verbs on an attested surface, all gated", () => {
    const { result } = build();
    expect(Object.keys(result!.tools).sort()).toEqual([
      "browser_act",
      "browser_navigate",
      "browser_observe",
      "browser_tabs",
      "browser_webmcp_invoke",
      "browser_webmcp_tools",
    ]);
    // Everything gates by default: a page is third-party code and the browser
    // is signed into things, so there is nothing trustworthy to relax on.
    expect([...result!.approvals.requiredNames].sort()).toEqual(
      Object.keys(result!.tools).sort(),
    );
    expect(result!.approvals.freeNames.size).toBe(0);
  });

  it("boots NOTHING until a tool is actually called", async () => {
    const { result, ensureSession } = build();
    expect(ensureSession).not.toHaveBeenCalled();
    await run(result!.tools, "browser_observe", {});
    expect(ensureSession).toHaveBeenCalledTimes(1);
    // Reused across calls in one turn.
    await run(result!.tools, "browser_observe", {});
    expect(ensureSession).toHaveBeenCalledTimes(1);
  });
});

describe("buildBrowserTools — unattended policy", () => {
  it("read_only builds ONLY the observation tools, and frees them", () => {
    const { result } = build({
      approvalDelivery: {
        kind: "unattended",
        policy: { mode: "read_only" },
      },
    });
    expect(Object.keys(result!.tools).sort()).toEqual([
      "browser_observe",
      "browser_webmcp_tools",
    ]);
    // Refusing to BUILD the interactive tools is stronger than gating them:
    // with nobody to ask, a gated tool in an unattended run would just run.
    expect([...result!.approvals.freeNames].sort()).toEqual([
      "browser_observe",
      "browser_webmcp_tools",
    ]);
    expect(result!.approvals.requiredNames.size).toBe(0);
  });

  it("allow_all keeps every tool, still classified as required", () => {
    const { result } = build({
      approvalDelivery: { kind: "unattended", policy: { mode: "allow_all" } },
    });
    expect(Object.keys(result!.tools)).toHaveLength(6);
    expect(result!.approvals.requiredNames.size).toBe(6);
  });

  it("an allowlist policy builds only the named tools", () => {
    const { result } = build({
      approvalDelivery: {
        kind: "unattended",
        policy: {
          mode: "allowlist",
          toolAllowlist: ["browser_navigate", "browser_observe"],
        },
      },
    });
    expect(Object.keys(result!.tools).sort()).toEqual([
      "browser_navigate",
      "browser_observe",
    ]);
  });

  it("returns nothing when the policy leaves no usable tools", () => {
    const suppressed: Array<{ id: string; reason: string }> = [];
    const built = buildBrowserTools({
      authHeader: "Bearer user",
      projectId: "project-1",
      approvalDelivery: {
        kind: "unattended",
        policy: { mode: "allowlist", toolAllowlist: ["nonexistent_tool"] },
      },
      onToolSuppressed: (info) => suppressed.push(info),
    });
    expect(built).toBeUndefined();
    expect(suppressed[0].reason).toContain("toolPolicy");
  });

  it("refuses an origin the policy never named, BEFORE the command leaves", async () => {
    const { result, sendCommand } = build({
      approvalDelivery: {
        kind: "unattended",
        policy: { mode: "allowlist", originAllowlist: ["https://allowed.test"] },
      },
    });
    const denied = await run(result!.tools, "browser_navigate", {
      url: "https://evil.test/steal",
    });
    expect(denied.error).toContain("origin_not_allowed");
    expect(sendCommand).not.toHaveBeenCalled();

    const allowed = await run(result!.tools, "browser_navigate", {
      url: "https://allowed.test/page",
    });
    expect(allowed.error).toBeUndefined();
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it("refuses a page tool the allowlist never named", async () => {
    const { result, sendCommand } = build({
      approvalDelivery: {
        kind: "unattended",
        policy: {
          mode: "allowlist",
          toolAllowlist: ["browser_webmcp_invoke", "webmcp:book_flight"],
        },
      },
    });
    const denied = await run(result!.tools, "browser_webmcp_invoke", {
      toolName: "delete_account",
    });
    expect(denied.error).toContain("tool_not_allowed");
    expect(sendCommand).not.toHaveBeenCalled();
  });
});

describe("buildBrowserTools — both failure layers", () => {
  it("reports a browser-level failure even though the transport said ok", async () => {
    // The trap: `{status:"ok", result:{ok:false}}` is HTTP 200. A caller that
    // branched on the status alone would report this as success.
    const { result } = build({}, async () => ({
      status: "ok",
      result: { ok: false, error: "target_not_found: #missing" },
    }));
    const out = await run(result!.tools, "browser_act", {
      verb: "click",
      selector: "#missing",
    });
    expect(out.error).toContain("target_not_found");
  });

  it("translates each transport rejection into something a model can act on", async () => {
    for (const [status, expected] of [
      ["busy", "busy"],
      ["at_capacity", "at_capacity"],
      ["unknown_boot", "unknown_boot"],
      ["expired", "expired"],
    ] as const) {
      const { result } = build({}, async () => ({ status }));
      const out = await run(result!.tools, "browser_observe", {});
      expect(out.error).toContain(expected);
    }
  });

  it("explains a stale observation as 'not performed', with the fresh page", async () => {
    const { result } = build({}, async () => ({
      status: "stale_observation",
      result: {
        ok: false,
        output: { url: "https://example.com/moved" },
        stateToken: { tabId: "@session", navCounter: 2, urlHash: "u2", domHash: "d2" },
      },
    }));
    const out = await run(result!.tools, "browser_act", {
      verb: "click",
      x: 10,
      y: 10,
    });
    expect(out.error).toContain("stale_observation");
    expect(out.error).toContain("NOT performed");
    expect(out.page).toMatchObject({ url: "https://example.com/moved" });
  });
});

describe("buildBrowserTools — L3 token threading", () => {
  it("pins an act to the token from the observation the model saw", async () => {
    const commands: any[] = [];
    const { result } = build({}, async (command) => {
      commands.push(command);
      return OK;
    });
    // Models never see or carry tokens: this layer remembers the last one and
    // pins the next act to it, which is what makes L3 protect against stale
    // targeting rather than being a parameter a model can forget.
    await run(result!.tools, "browser_observe", {});
    await run(result!.tools, "browser_act", { verb: "click", x: 1, y: 2 });

    const act = commands.at(-1);
    expect(act.action.kind).toBe("act");
    expect(act.action.expectedState).toMatchObject({ navCounter: 1 });
  });

  it("does not pin the FIRST act of a turn — there is no observation yet", async () => {
    const commands: any[] = [];
    const { result } = build({}, async (command) => {
      commands.push(command);
      return OK;
    });
    await run(result!.tools, "browser_act", { verb: "click", x: 1, y: 2 });
    expect(commands[0].action.expectedState).toBeUndefined();
  });

  it("never sends a token on a navigate or observe", async () => {
    const commands: any[] = [];
    const { result } = build({}, async (command) => {
      commands.push(command);
      return OK;
    });
    await run(result!.tools, "browser_observe", {});
    await run(result!.tools, "browser_navigate", { url: "https://x.test" });
    expect(commands.every((c) => c.action.expectedState === undefined)).toBe(true);
  });
});

describe("buildBrowserTools — command shapes", () => {
  it("maps navigate/back/reload and newTab", async () => {
    const commands: any[] = [];
    const { result } = build({}, async (command) => {
      commands.push(command);
      return OK;
    });
    await run(result!.tools, "browser_navigate", { url: "https://x.test" });
    await run(result!.tools, "browser_navigate", { action: "back" });
    await run(result!.tools, "browser_navigate", { action: "reload" });
    await run(result!.tools, "browser_navigate", {
      url: "https://y.test",
      newTab: true,
      tabId: "t2",
    });
    expect(commands.map((c) => c.action.kind)).toEqual([
      "navigate",
      "back",
      "reload",
      "navigate",
    ]);
    expect(commands[3].action.newTab).toBe(true);
    expect(commands[3].tabId).toBe("t2");
  });

  it("requires a url to goto", async () => {
    const { result, sendCommand } = build();
    const out = await run(result!.tools, "browser_navigate", {});
    expect(out.error).toContain("url");
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("maps tab management onto the act verbs", async () => {
    const commands: any[] = [];
    const { result } = build({}, async (command) => {
      commands.push(command);
      return OK;
    });
    await run(result!.tools, "browser_tabs", { action: "activate", tabId: "t2" });
    await run(result!.tools, "browser_tabs", { action: "close", tabId: "t2" });
    expect(commands.map((c) => c.action.verb)).toEqual([
      "activate_tab",
      "close_tab",
    ]);
  });

  it("surfaces an unsettled capture with a note instead of silently", async () => {
    const { result } = build({}, async () => ({
      status: "ok",
      result: { ok: true, output: { url: "https://x.test" }, settled: false },
    }));
    const out = await run(result!.tools, "browser_observe", {});
    expect(out.settled).toBe(false);
    expect(out.note).toContain("still loading");
  });
});
