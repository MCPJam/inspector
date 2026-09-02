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

describe("buildBrowserTools — a human has the browser (W4/L6)", () => {
  const LEASE_BLOCKED: SendResult = {
    status: "lease_blocked",
    bootId: "boot-1",
  };

  it("tells the model to WAIT, and says nothing was observed", async () => {
    // A bare "blocked" reads as a transient error and models retry it in a
    // loop; the useful information is that a person is mid-flow and that no
    // frame was captured, so waiting is correct and re-observing is required.
    const { result } = build({}, async () => LEASE_BLOCKED);
    const out = await run(result!.tools, "browser_observe", {});
    expect(out.error).toContain("browser_in_use");
    expect(out.error).toContain("Wait");
    expect(out.error).toMatch(/nothing was observed/i);
  });

  it("drops cached page tokens, so the next act cannot be pinned to a pre-handoff page", async () => {
    const commands: any[] = [];
    let reply: SendResult = OK;
    const { result } = build({}, async (command) => {
      commands.push(command);
      return reply;
    });

    // 1. Observe normally — the turn now holds a token for this tab.
    await run(result!.tools, "browser_observe", {});
    // 2. An act while nothing has happened IS pinned to it (L3 working).
    await run(result!.tools, "browser_act", {
      verb: "click",
      coordinates: [1, 2],
    });
    expect(commands.at(-1).action.expectedState).toBeDefined();

    // 3. A person takes the browser.
    reply = LEASE_BLOCKED;
    await run(result!.tools, "browser_observe", {});

    // 4. The next act must NOT carry the pre-handoff token: whatever we saw
    //    describes a page a human has since navigated or logged into.
    reply = OK;
    await run(result!.tools, "browser_act", {
      verb: "click",
      coordinates: [1, 2],
    });
    expect(commands.at(-1).action.expectedState).toBeUndefined();
  });

  it("drops cached tokens when the daemon reports the handoff on the way back", async () => {
    const commands: any[] = [];
    let reply: SendResult = OK;
    const { result } = build({}, async (command) => {
      commands.push(command);
      return reply;
    });
    await run(result!.tools, "browser_observe", {});

    // The daemon attaches the note to the FIRST result after a resume.
    reply = {
      status: "ok",
      result: {
        ok: true,
        output: { url: "https://x.test", handoffNote: "A person took control…" },
        stateToken: {
          tabId: "@session",
          navCounter: 9,
          urlHash: "u9",
          domHash: "d9",
        },
      },
    };
    const noted = await run(result!.tools, "browser_observe", {});
    // The note is presented to the model at the top level, like every other
    // observation field — it is something the model must read, not metadata.
    expect(noted).toMatchObject({ handoffNote: expect.any(String) });

    // That observation is FRESH, so its own token survives the drop and the
    // very next act is pinned again — the turn is caught up in one step, not
    // left with L3 disabled for the rest of it.
    reply = OK;
    await run(result!.tools, "browser_act", {
      verb: "click",
      coordinates: [1, 2],
    });
    expect(commands.at(-1).action.expectedState).toMatchObject({
      navCounter: 9,
    });
  });
});

describe("the screenshot reaches the model as an IMAGE, not as text", () => {
  it("maps a capture to image content and drops it from the text half", async () => {
    // Left in the JSON result the capture is text to every provider: the model
    // cannot see the page it is being asked to click on, and the turn pays
    // tens of thousands of tokens for the privilege.
    const { result } = build();
    const tools = result!.tools as any;
    const output = await run(tools, "browser_navigate", {
      url: "https://example.com",
    });

    const mapped = tools.browser_navigate.toModelOutput({ output });

    expect(mapped.type).toBe("content");
    expect(mapped.value[0]).toEqual({
      type: "image-data",
      data: "PNG",
      mediaType: "image/png",
    });
    const text = mapped.value.find((p: any) => p.type === "text");
    expect(text.text).toContain("https://example.com");
    // Not duplicated as text — that duplication is the token cost.
    expect(text.text).not.toContain("PNG");
  });

  it("labels a JPEG capture as JPEG (the daemon captures JPEG)", async () => {
    const jpeg = "/9j/4AAQSkZJRg";
    const { result } = build({}, async () => ({
      status: "ok",
      result: { ok: true, output: { url: "https://x.test", screenshot: jpeg } },
    }));
    const tools = result!.tools as any;
    const output = await run(tools, "browser_observe", {});
    const mapped = tools.browser_observe.toModelOutput({ output });
    expect(mapped.value[0]).toMatchObject({ mediaType: "image/jpeg", data: jpeg });
  });

  it("lifts the capture out of a stale_observation refusal, where it matters most", async () => {
    // The act did not run and the page moved; the fresh observation riding the
    // refusal is exactly what the model needs to LOOK at to re-decide.
    const { result } = build({}, async () => ({
      status: "stale_observation",
      result: {
        ok: false,
        output: { url: "https://moved.test", screenshot: "FRESH" },
      },
    }));
    const tools = result!.tools as any;
    const output = await run(tools, "browser_act", { verb: "click", x: 5, y: 5 });

    const mapped = tools.browser_act.toModelOutput({ output });

    expect(mapped.value[0]).toMatchObject({ type: "image-data", data: "FRESH" });
    const text = mapped.value.find((p: any) => p.type === "text");
    expect(text.text).toContain("stale_observation");
    expect(text.text).toContain("https://moved.test");
    expect(text.text).not.toContain("FRESH");
  });

  it("emits text only when a result carries no capture", async () => {
    const { result } = build({}, async () => ({
      status: "ok",
      result: { ok: true, output: { url: "https://x.test" } },
    }));
    const tools = result!.tools as any;
    const output = await run(tools, "browser_observe", { mode: "url" });
    const mapped = tools.browser_observe.toModelOutput({ output });
    expect(mapped.value).toHaveLength(1);
    expect(mapped.value[0].type).toBe("text");
  });

  it("is attached to EVERY built browser tool", async () => {
    // A tool added later that forgot the mapping silently goes back to
    // sending the model an unreadable base64 string.
    const { result } = build();
    for (const [name, definition] of Object.entries(result!.tools as any)) {
      expect(
        typeof (definition as any).toModelOutput,
        `${name} must map its output for the model`,
      ).toBe("function");
    }
  });
});

describe("the coordinate space is stated and enforced", () => {
  it("names the viewport and the origin in the act tool's description", async () => {
    const { result } = build();
    const description = (result!.tools as any).browser_act.description as string;
    expect(description).toContain("1024x768");
    expect(description).toMatch(/top-left/i);
  });

  it("bounds x and y in the schema", () => {
    const { result } = build();
    const schema = (result!.tools as any).browser_act.inputSchema;
    expect(schema.safeParse({ verb: "click", x: 1024, y: 10 }).success).toBe(false);
    expect(schema.safeParse({ verb: "click", x: -1, y: 10 }).success).toBe(false);
    expect(schema.safeParse({ verb: "click", x: 1023, y: 767 }).success).toBe(true);
  });

  it("REFUSES an out-of-range coordinate at execute time, without sending a command", async () => {
    // The schema states the bound, but a hosted path reconstructs the schema
    // on the wire and executes with whatever comes back — so the bound is
    // re-checked rather than assumed.
    const { result, sendCommand } = build();
    const tools = result!.tools as any;

    const output: any = await run(tools, "browser_act", {
      verb: "click",
      x: 4000,
      y: 10,
    });

    expect(output.error).toMatch(/out_of_viewport/);
    expect(output.error).toContain("1024x768");
    expect(sendCommand).not.toHaveBeenCalled();
  });
});

describe("browser_observe carries the omission marker's retrieval verb", () => {
  it("forwards rootSelector to the daemon", async () => {
    // `observation-budget.ts` tells the model to re-read an omitted subtree
    // with {mode:"a11y", rootSelector:"…"}; if the parameter stops here, the
    // marker points at a dead end.
    const { result, sendCommand } = build();
    await run(result!.tools as any, "browser_observe", {
      mode: "a11y",
      rootSelector: "#panel",
    });
    expect(sendCommand.mock.calls[0][0].action).toMatchObject({
      kind: "observe",
      mode: "a11y",
      rootSelector: "#panel",
    });
  });

  it("omits the field entirely when no selector is given", async () => {
    const { result, sendCommand } = build();
    await run(result!.tools as any, "browser_observe", { mode: "a11y" });
    expect(sendCommand.mock.calls[0][0].action).not.toHaveProperty("rootSelector");
  });
});
