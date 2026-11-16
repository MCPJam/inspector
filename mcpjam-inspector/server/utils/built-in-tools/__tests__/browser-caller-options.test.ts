/**
 * The caller-only options an unattended run sets on the browser tools: a stop
 * at the page the run ends on, credentials limited to one origin, and a gate
 * before a credential leaves this process. The model sees none of them.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../computers/browser-consent.js", () => ({
  verifyLocalBrowserConsent: vi.fn(async () => true),
}));
import { buildBrowserTools, BrowserTokenMemory } from "../browser";
import type { BrowserSessionHandle } from "../../../services/browserd/browser-session";
import {
  createFeatureCheck,
  requiredDaemonFeatures,
  secretDeliveryOutcome,
} from "../browser-caller-options";

const CALLBACK = "https://app.mcpjam.com/oauth/callback";
const AUTH = "https://auth.example.com";
const PASSWORD = "reviewer-password-sample-1";
const ALL_FEATURES = [
  "secret-placeholders",
  "secret-origins",
  "navigation-stop-persistent",
];

function build(
  over: Record<string, unknown> = {},
  options: {
    features?: string[];
    reply?: (command: any) => Record<string, unknown>;
  } = {},
) {
  const sent: { command: any; options?: { secrets?: any[] } }[] = [];
  const status = vi.fn(async () => ({
    kind: "ok",
    features: options.features ?? ALL_FEATURES,
  }));
  const sendCommand = vi.fn(async (command: any, _boot?: string, opts?: any) => {
    sent.push({ command, options: opts });
    return {
      status: "ok",
      result: options.reply?.(command) ?? {
        ok: true,
        output: { url: `${AUTH}/login`, a11y: 'textbox "Password" [ref=e1]' },
        stateToken: { tabId: "@session", navCounter: 1, urlHash: "u", domHash: "d" },
      },
      bootId: "boot-1",
    };
  });
  const handle = {
    engine: "hosted" as const,
    target: "computer" as const,
    sessionId: "session-1",
    computerId: "computer-1",
    bootId: "boot-1",
    client: { sendCommand, status } as never,
    streamUrl: "https://stream.example/vnc.html",
    streamPassword: "pw",
    contextMode: "ephemeral",
    reused: false,
  } as BrowserSessionHandle;
  const result = buildBrowserTools({
    authHeader: "",
    projectId: "project-1",
    engine: "hosted",
    approvalDelivery: {
      kind: "unattended",
      policy: {
        mode: "allowlist",
        toolAllowlist: ["browser_navigate", "browser_act", "browser_observe"],
      },
    },
    runKey: "readiness:run-1",
    sandboxTarget: { sandboxRowId: "row-1", sandboxId: "box-1" },
    ensureSession: async () => handle,
    tokenMemory: new BrowserTokenMemory(),
    ...over,
  });
  return { tools: result!.tools as any, sent, status };
}

const call = { toolCallId: "call-1" };

describe("the stop at the page the run ends on", () => {
  it("rides on every command and hands the URL to the caller alone", async () => {
    const onStopped = vi.fn();
    const stoppedAt = `${CALLBACK}?code=secret-code&state=s1`;
    const { tools, sent } = build(
      { navigationStop: { url: CALLBACK, onStopped } },
      { reply: () => ({ ok: true, stoppedAt }) },
    );
    const answer = await tools.browser_act.execute(
      { verb: "click", ref: "e2" },
      call,
    );
    expect(sent[0].command).toMatchObject({
      stopAt: CALLBACK,
      stopAtPersistent: true,
    });
    expect(onStopped).toHaveBeenCalledWith(stoppedAt);
    expect(JSON.stringify(answer)).not.toContain("secret-code");
    expect(JSON.stringify(answer)).not.toContain(CALLBACK);
    expect(answer.stopped).toBe(true);
  });

  it("leaves commands untouched without one", async () => {
    const { tools, sent, status } = build();
    await tools.browser_observe.execute({}, call);
    expect(sent[0].command.stopAt).toBeUndefined();
    expect(status).not.toHaveBeenCalled();
  });

  it("runs nothing on a daemon that cannot stop", async () => {
    const { tools, sent } = build(
      { navigationStop: { url: CALLBACK, onStopped: vi.fn() } },
      { features: ["secret-placeholders", "secret-origins"] },
    );
    const answer = await tools.browser_navigate.execute(
      { url: `${AUTH}/login` },
      call,
    );
    expect(sent).toEqual([]);
    expect(answer.error).toMatch(/cannot stop at the page this run ends on/);
  });
});

describe("credentials limited to an origin", () => {
  const limited = {
    available: [{ name: "REVIEWER_PASSWORD", value: PASSWORD, origins: [AUTH] }],
  };
  const typePassword = {
    verb: "type",
    ref: "e1",
    value: "{{secret:REVIEWER_PASSWORD}}",
  };

  it("sends the origins beside the command, never in it", async () => {
    const { tools, sent } = build({ secrets: limited });
    await tools.browser_act.execute(typePassword, call);
    expect(sent[0].options?.secrets).toEqual([
      { name: "REVIEWER_PASSWORD", value: PASSWORD, origins: [AUTH] },
    ]);
    expect(JSON.stringify(sent[0].command)).not.toContain(PASSWORD);
  });

  it("types nothing on a daemon that cannot enforce them", async () => {
    const { tools, sent } = build(
      { secrets: limited },
      { features: ["secret-placeholders"] },
    );
    const answer = await tools.browser_act.execute(typePassword, call);
    expect(sent).toEqual([]);
    expect(answer.error).toMatch(/cannot limit a credential/);
  });

  it("types a credential only into a named field", async () => {
    const { tools, sent } = build({ secrets: limited });
    const answer = await tools.browser_act.execute(
      { verb: "type", value: "{{secret:REVIEWER_PASSWORD}}" },
      call,
    );
    expect(sent).toEqual([]);
    expect(answer.error).toMatch(/^secret_target_required/);
  });

  it("asks the gate before a value leaves, and stops when it refuses", async () => {
    const beforeDeliver = vi.fn(async () => "password_already_submitted: no");
    const { tools, sent } = build({ secrets: { ...limited, beforeDeliver } });
    const answer = await tools.browser_act.execute(typePassword, call);
    expect(beforeDeliver).toHaveBeenCalledWith(["REVIEWER_PASSWORD"], {
      commandId: expect.any(String),
    });
    expect(sent).toEqual([]);
    expect(answer.error).toBe("password_already_submitted: no");
  });

  it("reports whether the credential reached a field", async () => {
    const afterDeliver = vi.fn(async () => {});
    const typed = build({ secrets: { ...limited, afterDeliver } });
    await typed.tools.browser_act.execute(typePassword, call);
    expect(afterDeliver).toHaveBeenLastCalledWith(["REVIEWER_PASSWORD"], {
      commandId: typed.sent[0].command.commandId,
      outcome: "typed",
    });
    const refused = build(
      { secrets: { ...limited, afterDeliver } },
      { reply: () => ({ ok: false, error: "stale_ref: e1 is gone" }) },
    );
    await refused.tools.browser_act.execute(typePassword, call);
    expect(afterDeliver).toHaveBeenLastCalledWith(["REVIEWER_PASSWORD"], {
      commandId: refused.sent[0].command.commandId,
      outcome: "not_typed",
    });
    // A person taking the browser partway through cannot prove nothing was typed.
    const taken = secretDeliveryOutcome({ status: "lease_blocked" });
    expect(taken).toBe("unknown");
    for (const status of ["stale_observation", "busy", "at_capacity"]) {
      expect(secretDeliveryOutcome({ status })).toBe("not_typed");
    }
    // An id that already ran may have typed it.
    expect(secretDeliveryOutcome({ status: "expired" })).toBe("unknown");
    const unclear = build(
      { secrets: { ...limited, afterDeliver } },
      { reply: () => ({ ok: false, error: "act_failed: the page threw" }) },
    );
    await unclear.tools.browser_act.execute(typePassword, call);
    expect(afterDeliver).toHaveBeenLastCalledWith(
      ["REVIEWER_PASSWORD"],
      expect.objectContaining({ outcome: "unknown" }),
    );
  });

  it("does not ask the gate for a command with no credential", async () => {
    const beforeDeliver = vi.fn(async () => undefined);
    const { tools } = build({ secrets: { ...limited, beforeDeliver } });
    await tools.browser_act.execute({ verb: "type", ref: "e1", value: "me@x.test" }, call);
    expect(beforeDeliver).not.toHaveBeenCalled();
  });
});

describe("feature checks", () => {
  it("needs what the command carries", () => {
    expect(requiredDaemonFeatures({})).toEqual([]);
    expect(
      requiredDaemonFeatures({
        secrets: [{ name: "A", value: "v", origins: [AUTH] }],
        navigationStop: { url: CALLBACK, onStopped: () => {} },
      }),
    ).toEqual(ALL_FEATURES);
  });

  it("asks a daemon once per boot, and again after a failed answer", async () => {
    const check = createFeatureCheck();
    const status = vi
      .fn()
      .mockResolvedValueOnce({ kind: "unreachable" })
      .mockResolvedValue({ kind: "ok", features: ALL_FEATURES });
    const handle = { bootId: "b1", client: { status } };
    expect(await check(handle, ["secret-origins"])).toMatch(/cannot limit/);
    expect(await check(handle, ["secret-origins"])).toBeUndefined();
    expect(await check(handle, ["navigation-stop-persistent"])).toBeUndefined();
    expect(status).toHaveBeenCalledTimes(2);
    await check({ ...handle, bootId: "b2" }, ["secret-origins"]);
    expect(status).toHaveBeenCalledTimes(3);
  });
});
