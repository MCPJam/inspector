import { describe, expect, it } from "vitest";
import { toBrowserAction, toWebMcpCommandResult } from "../v1-bridge";
import type { WebMcpCommand } from "@/shared/webmcp-inspector-protocol";
import type { BrowserCommandResult } from "../protocol";

/** Every V1 command, so a new one added to the protocol fails here loudly. */
const ALL_COMMANDS: WebMcpCommand[] = [
  { type: "navigate", url: "https://x.test/" },
  { type: "reload" },
  { type: "go_back" },
  { type: "invoke_tool", toolKey: "frame1::search", input: { q: "a" }, source: "chat" },
  { type: "cancel_invocation", invokeId: "inv-1" },
  { type: "capture_screenshot" },
];

const OK = (output?: unknown): BrowserCommandResult => ({ ok: true, output });

describe("toBrowserAction", () => {
  it("translates every V1 command shape", () => {
    const resolve = (id: string) => `daemon-${id}`;
    const actions = ALL_COMMANDS.map((c) => toBrowserAction(c, resolve));
    expect(actions.every((a) => a.ok)).toBe(true);
    expect(actions.map((a) => (a.ok ? a.action.kind : "REFUSED"))).toEqual([
      "navigate",
      "reload",
      "back",
      "webmcp_invoke",
      "webmcp_cancel",
      "observe",
    ]);
  });

  it("carries navigate and invoke payloads through unchanged", () => {
    const nav = toBrowserAction({ type: "navigate", url: "https://x.test/a?b=c" });
    expect(nav).toEqual({
      ok: true,
      action: { kind: "navigate", url: "https://x.test/a?b=c" },
    });
    const invoke = toBrowserAction({
      type: "invoke_tool",
      toolKey: "frame1::search",
      input: { q: "hello", n: 3 },
      source: "manual",
    });
    expect(invoke).toEqual({
      ok: true,
      action: {
        kind: "webmcp_invoke",
        toolKey: "frame1::search",
        input: { q: "hello", n: 3 },
      },
    });
  });

  it("REFUSES a cancel it cannot resolve rather than cancelling by guess", () => {
    // A cancel that matches nothing reads to the user as "the stop button does
    // not work" — worse than an honest refusal, and much worse than the other
    // possibility, which is cancelling somebody else's invocation.
    const refused = toBrowserAction({
      type: "cancel_invocation",
      invokeId: "inv-unknown",
    });
    expect(refused).toMatchObject({ ok: false, reason: "unsupported_command" });
    expect(refused.ok === false && refused.detail).toContain("inv-unknown");

    const resolved = toBrowserAction(
      { type: "cancel_invocation", invokeId: "inv-1" },
      (id) => (id === "inv-1" ? "daemon-7" : undefined),
    );
    expect(resolved).toEqual({
      ok: true,
      action: { kind: "webmcp_cancel", invocationId: "daemon-7" },
    });
  });

  it("maps a screenshot to an OBSERVE, not an act", () => {
    // Both protocols treat a screenshot as a side-effect-free read; routing it
    // through the act path would put it behind act's approval and staleness
    // machinery for no reason.
    expect(toBrowserAction({ type: "capture_screenshot" })).toEqual({
      ok: true,
      action: { kind: "observe", mode: "screenshot" },
    });
  });
});

describe("toWebMcpCommandResult", () => {
  it("returns a bare ok for the navigation commands", () => {
    for (const command of ALL_COMMANDS.slice(0, 3)) {
      expect(toWebMcpCommandResult(command, OK({ url: "https://x.test/" }))).toEqual({
        ok: true,
      });
    }
  });

  it("surfaces the invocation id when the daemon reports one", () => {
    const command: WebMcpCommand = {
      type: "invoke_tool",
      toolKey: "k",
      input: {},
      source: "chat",
    };
    expect(
      toWebMcpCommandResult(command, OK({ invocationId: "inv-9" })),
    ).toEqual({ ok: true, invokeId: "inv-9" });
    // An invoke that reports no id is still a success — V1 tracks it by the
    // activity stream — so this must not become a failure.
    expect(toWebMcpCommandResult(command, OK({}))).toEqual({ ok: true });
  });

  it("reports a cancel that came too late as cancelled:false", () => {
    const command: WebMcpCommand = {
      type: "cancel_invocation",
      invokeId: "inv-1",
    };
    expect(toWebMcpCommandResult(command, OK({ cancelled: true }))).toEqual({
      ok: true,
      cancelled: true,
    });
    expect(toWebMcpCommandResult(command, OK({ cancelled: false }))).toEqual({
      ok: true,
      cancelled: false,
    });
    // Absent means the daemon did not say it stopped anything; claiming it did
    // would be the one lie that matters here.
    expect(toWebMcpCommandResult(command, OK({}))).toEqual({
      ok: true,
      cancelled: false,
    });
  });

  it("passes a screenshot through, and omits it when there is none", () => {
    const command: WebMcpCommand = { type: "capture_screenshot" };
    expect(
      toWebMcpCommandResult(command, OK({ screenshot: "BASE64PNG" })),
    ).toEqual({ ok: true, screenshotBase64: "BASE64PNG" });
    expect(toWebMcpCommandResult(command, OK({}))).toEqual({ ok: true });
  });

  it("turns a daemon failure into a refusal carrying the daemon's reason", () => {
    for (const command of ALL_COMMANDS) {
      const failed = toWebMcpCommandResult(command, {
        ok: false,
        error: "webmcp_tool_gone: the frame navigated away",
      });
      expect(failed).toMatchObject({ ok: false, reason: "unsupported_command" });
      expect(failed.ok === false && failed.detail).toContain("webmcp_tool_gone");
    }
  });

  it("never claims success for a failure with no stated reason", () => {
    const failed = toWebMcpCommandResult({ type: "reload" }, { ok: false });
    expect(failed).toMatchObject({ ok: false });
    expect(failed.ok === false && failed.detail).toBeTruthy();
  });
});
