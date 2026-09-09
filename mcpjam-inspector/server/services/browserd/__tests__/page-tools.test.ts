/**
 * The pane's page-tools read, at the two points it can go wrong quietly:
 *
 *   1. BOTH LAYERS. A command can be refused by the transport OR fail inside
 *      the browser with a 200. Reading only the first reports a failed read as
 *      an empty page — "this page offers no tools" about a page nobody looked
 *      at.
 *   2. A HELD LEASE IS NOT A FAULT. The daemon refuses to observe while a
 *      person has the browser, and that has to reach the pane as its own state
 *      so it can say "someone took control" rather than "unreachable".
 */
import { describe, expect, it } from "vitest";
import {
  pageToolsFromCommandResponse,
  webmcpToolsObserveCommand,
} from "../page-tools";

const TOKEN = { tabId: "@session", navCounter: 1, urlHash: "u", domHash: "d" };

describe("webmcpToolsObserveCommand", () => {
  it("sends the observation the chat turn's own page-tool peek sends", () => {
    const command = webmcpToolsObserveCommand({ source: "inspector" });
    expect(command.action).toEqual({ kind: "observe", mode: "webmcp_tools" });
    expect(command.source).toBe("inspector");
    expect(command.commandId).toMatch(/[0-9a-f-]{36}/);
  });

  it("carries the holder only for a manual read", () => {
    // The daemon checks `holder` against the LIVE lease, and refuses a manual
    // command that names nobody — so omitting it on an inspector read is not a
    // detail, it is what keeps the two paths distinguishable.
    expect(
      webmcpToolsObserveCommand({ source: "inspector" }).holder,
    ).toBeUndefined();
    expect(
      webmcpToolsObserveCommand({ source: "manual", holder: "users_1" }).holder,
    ).toBe("users_1");
  });

  it("targets a named tab, and omits the key entirely otherwise", () => {
    // An explicit `tabId: undefined` is not the same as no tabId: the daemon
    // keys its FIFO on the field's presence.
    expect(
      webmcpToolsObserveCommand({ source: "inspector" }),
    ).not.toHaveProperty("tabId");
    expect(
      webmcpToolsObserveCommand({ source: "inspector", tabId: "tab-2" }).tabId,
    ).toBe("tab-2");
  });

  it("mints a fresh idempotency key per read", () => {
    const a = webmcpToolsObserveCommand({ source: "inspector" });
    const b = webmcpToolsObserveCommand({ source: "inspector" });
    // The daemon runs a given commandId AT MOST ONCE per boot: a reused id
    // would make the refresh button do nothing after the first click.
    expect(a.commandId).not.toBe(b.commandId);
  });
});

describe("pageToolsFromCommandResponse", () => {
  it("returns the page's tools on success", () => {
    const mapped = pageToolsFromCommandResponse({
      status: "ok",
      bootId: "boot-1",
      result: {
        ok: true,
        output: {
          url: "https://webmcp.dev/",
          webmcpSupported: true,
          tools: [{ name: "bookSlot", description: "Reserve a slot" }],
        },
        stateToken: TOKEN,
      },
    });
    expect(mapped.status).toBe(200);
    expect(mapped.body).toEqual({
      ok: true,
      url: "https://webmcp.dev/",
      webmcpSupported: true,
      tools: [{ name: "bookSlot", description: "Reserve a slot" }],
    });
  });

  it("reports a browser-side failure rather than an empty page", () => {
    // HTTP 200 with `result.ok === false`. Read as success this is
    // indistinguishable from a page that genuinely offers nothing.
    const mapped = pageToolsFromCommandResponse({
      status: "ok",
      bootId: "boot-1",
      result: { ok: false, error: "navigation_failed" },
    });
    expect(mapped.status).toBe(502);
    expect(mapped.body).toEqual({
      ok: false,
      error: "unreachable",
      detail: "navigation_failed",
    });
  });

  it("names a browser with nothing open as its own state", () => {
    // The driver refuses to conjure an `about:blank` tab to observe, so this
    // is the ORDINARY answer between a session starting and the model's first
    // navigation. Reported as `unreachable` it would put a red message over a
    // browser that is working perfectly.
    const mapped = pageToolsFromCommandResponse({
      status: "ok",
      bootId: "boot-1",
      result: { ok: false, error: "unknown_tab: @session" },
    });
    expect(mapped.status).toBe(409);
    expect(mapped.body).toEqual({ ok: false, error: "no_page" });
  });

  it("names a held lease as its own state", () => {
    const mapped = pageToolsFromCommandResponse({
      status: "lease_blocked",
      lease: "held",
      holder: "users_2",
      bootId: "boot-1",
    });
    expect(mapped.status).toBe(423);
    expect(mapped.body).toEqual({ ok: false, error: "lease_held" });
    // The HOLDER never leaves the daemon boundary through this route: the pane
    // says somebody has the browser, not who.
    expect(JSON.stringify(mapped.body)).not.toContain("users_2");
  });

  it("maps every transient refusal to `busy`", () => {
    for (const status of ["busy", "at_capacity", "expired"] as const) {
      const mapped = pageToolsFromCommandResponse({ status, bootId: "boot-1" });
      expect(mapped.status).toBe(429);
      expect(mapped.body).toEqual({ ok: false, error: "busy" });
    }
  });

  it("treats a vanished daemon as no browser session", () => {
    // The row describes a boot that is gone. To the pane that is the same as
    // "nothing is running" — the next chat turn re-ensures one.
    const mapped = pageToolsFromCommandResponse({
      status: "unknown_boot",
      bootId: "boot-2",
    });
    expect(mapped.status).toBe(409);
    expect(mapped.body).toEqual({ ok: false, error: "no_browser_session" });
  });

  it("falls back to unreachable for a status it does not know", () => {
    const mapped = pageToolsFromCommandResponse({
      status: "stale_observation",
      bootId: "boot-1",
    });
    expect(mapped.status).toBe(502);
    expect(mapped.body).toMatchObject({ ok: false, error: "unreachable" });
  });
});
