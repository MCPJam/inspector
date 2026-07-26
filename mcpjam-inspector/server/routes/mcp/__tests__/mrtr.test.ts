import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  InputRequests,
  MrtrInputCollector,
  MrtrOperationState,
} from "@mcpjam/sdk";
import {
  projectInputRequests,
  registerLocalMrtrCollector,
  submitMrtrResponses,
  pendingMrtrRoundCount,
  withLocalMrtrElicitationCapability,
} from "../mrtr.js";

/**
 * The LOCAL MRTR bridge: the collector is registered BEFORE connect, surfaces a
 * round to the browser, and returns the collected `InputResponses` INTO the SDK
 * driver loop. Decline/cancel are responses; abort rejects; rounds replace.
 */

// A fake manager that just captures the registered collector — the real driver
// wiring and capability advertisement are covered by the SDK's own tests. What
// matters here is the bridge behavior around that collector.
function fakeManager() {
  let collector: MrtrInputCollector | undefined;
  return {
    manager: {
      setMrtrInputCollector: (_serverId: string, c: MrtrInputCollector) => {
        collector = c;
      },
    } as any,
    getCollector: () => collector,
  };
}

function elicitRequest(message: string, key = "q"): InputRequests {
  const map = Object.create(null) as InputRequests;
  (map as any)[key] = {
    method: "elicitation/create",
    params: {
      message,
      requestedSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
    },
  };
  return map;
}

function urlRequest(url: string, key = "u"): InputRequests {
  const map = Object.create(null) as InputRequests;
  (map as any)[key] = {
    method: "elicitation/create",
    params: { message: "Open link", mode: "url", url },
  };
  return map;
}

function state(opId: string, round: number): MrtrOperationState {
  return {
    opId,
    method: "tools/call",
    originalParams: { name: "confirm", arguments: {} },
    round,
    maxRounds: 10,
    pendingInputRequests: Object.create(null),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("projectInputRequests", () => {
  it("projects a form request (message + schema, no url)", () => {
    const out = projectInputRequests(elicitRequest("How are you?"));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      key: "q",
      mode: "form",
      message: "How are you?",
    });
    expect(out[0].requestedSchema).toBeDefined();
    expect(out[0].url).toBeUndefined();
  });

  it("projects a url request (message + url, no schema)", () => {
    const out = projectInputRequests(urlRequest("https://example.com/consent"));
    expect(out[0]).toMatchObject({
      key: "u",
      mode: "url",
      url: "https://example.com/consent",
    });
    expect(out[0].requestedSchema).toBeUndefined();
  });

  it("uses server keys as values only — a hostile __proto__ key is safe", () => {
    const map = Object.create(null) as InputRequests;
    (map as any)["__proto__"] = {
      method: "elicitation/create",
      params: { message: "hi", requestedSchema: {} },
    };
    const out = projectInputRequests(map);
    expect(out.map((r) => r.key)).toEqual(["__proto__"]);
    // The real Object prototype is untouched.
    expect(({} as any).message).toBeUndefined();
  });
});

describe("registerLocalMrtrCollector", () => {
  it("registers exactly once per (manager, serverId)", () => {
    const { manager } = fakeManager();
    const spy = vi.spyOn(manager, "setMrtrInputCollector");
    registerLocalMrtrCollector(manager, "srv");
    registerLocalMrtrCollector(manager, "srv");
    expect(spy).toHaveBeenCalledTimes(1);
    registerLocalMrtrCollector(manager, "other");
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("collector round-trip", () => {
  it("resolves a single form round with the accepted content", async () => {
    const { manager, getCollector } = fakeManager();
    registerLocalMrtrCollector(manager, "srv-form-1");
    const collect = getCollector()!;

    const inputRequests = elicitRequest("Name?");
    const promise = collect({ state: state("op1", 1), inputRequests });
    expect(pendingMrtrRoundCount()).toBeGreaterThanOrEqual(1);

    const res = submitMrtrResponses("op1", {
      q: { action: "accept", content: { answer: "Ada" } },
    });
    expect(res.ok).toBe(true);

    const responses = await promise;
    expect(responses.q).toEqual({ action: "accept", content: { answer: "Ada" } });
  });

  it("treats decline and cancel as responses, not thrown errors", async () => {
    const { manager, getCollector } = fakeManager();
    registerLocalMrtrCollector(manager, "srv-decline");
    const collect = getCollector()!;

    const declineP = collect({ state: state("op-decline", 1), inputRequests: elicitRequest("x") });
    submitMrtrResponses("op-decline", { q: { action: "decline" } });
    await expect(declineP).resolves.toEqual({ q: { action: "decline" } });

    const cancelP = collect({ state: state("op-cancel", 1), inputRequests: elicitRequest("x") });
    submitMrtrResponses("op-cancel", { q: { action: "cancel" } });
    await expect(cancelP).resolves.toEqual({ q: { action: "cancel" } });
  });

  it("resolves a url round with a consent (accept, no content)", async () => {
    const { manager, getCollector } = fakeManager();
    registerLocalMrtrCollector(manager, "srv-url");
    const collect = getCollector()!;

    const p = collect({
      state: state("op-url", 1),
      inputRequests: urlRequest("https://ex/consent"),
    });
    submitMrtrResponses("op-url", { u: { action: "accept" } });
    await expect(p).resolves.toEqual({ u: { action: "accept", content: {} } });
  });

  it("drives two sequential rounds with REPLACEMENT, not accumulation", async () => {
    const { manager, getCollector } = fakeManager();
    registerLocalMrtrCollector(manager, "srv-seq");
    const collect = getCollector()!;

    // Round 1
    const r1 = collect({ state: state("op-seq", 1), inputRequests: elicitRequest("first", "a") });
    submitMrtrResponses("op-seq", { a: { action: "accept", content: { answer: "one" } } });
    const resp1 = await r1;
    expect(Object.keys(resp1)).toEqual(["a"]);

    // Round 2 — a DIFFERENT key. The bridge holds no memory of round 1: the
    // second round's responses stand alone (replacement, not accumulation).
    const r2 = collect({ state: state("op-seq", 2), inputRequests: elicitRequest("second", "b") });
    submitMrtrResponses("op-seq", { b: { action: "accept", content: { answer: "two" } } });
    const resp2 = await r2;
    expect(Object.keys(resp2)).toEqual(["b"]);
    expect((resp2 as any).a).toBeUndefined();
  });

  it("rejects the collector on abort — never a synthetic decline", async () => {
    const { manager, getCollector } = fakeManager();
    registerLocalMrtrCollector(manager, "srv-abort");
    const collect = getCollector()!;

    const controller = new AbortController();
    const p = collect({
      state: state("op-abort", 1),
      inputRequests: elicitRequest("x"),
      signal: controller.signal,
    });
    controller.abort();
    await expect(p).rejects.toBeInstanceOf(DOMException);
    // The pending round was cleared; a late submit finds nothing.
    expect(submitMrtrResponses("op-abort", { q: { action: "accept", content: {} } }).ok).toBe(false);
  });

  it("400s a round missing a required key and 404s an unknown op", () => {
    const { manager, getCollector } = fakeManager();
    registerLocalMrtrCollector(manager, "srv-validate");
    const collect = getCollector()!;
    void collect({ state: state("op-val", 1), inputRequests: elicitRequest("x", "needed") });

    const missing = submitMrtrResponses("op-val", { wrong: { action: "accept", content: {} } });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(400);

    const unknown = submitMrtrResponses("nope", { q: { action: "accept", content: {} } });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.status).toBe(404);
  });
});

describe("advertised elicitation capability", () => {
  // Bare `{}` is form-ONLY under the spec's back-compat rule, and the SDK
  // derives the MRTR mode allowlist from what was advertised — so leaving it
  // bare makes every url round fail validation before `UrlElicitationConsent`
  // is ever reached. The two eras share one capability on the wire, so `url`
  // may only be declared when no legacy version can be negotiated.
  const modern = ["2026-07-28"];
  const mixed = ["2026-07-28", "2025-11-25"];

  it("declares both modes on a modern-only connection", () => {
    const config = withLocalMrtrElicitationCapability({
      url: new URL("https://example.test/mcp"),
      supportedProtocolVersions: modern,
    } as never) as { capabilities?: Record<string, unknown> };
    expect(config.capabilities?.elicitation).toEqual({ form: {}, url: {} });
  });

  it("stays form-only when a legacy version can still be negotiated", () => {
    // `auto` proposes 2026-07-28 but accepts 2025-11-25, whose inbound
    // `elicitation/create` is fulfilled by the form-only legacy bridge.
    const config = withLocalMrtrElicitationCapability({
      url: new URL("https://example.test/mcp"),
      supportedProtocolVersions: mixed,
    } as never) as { capabilities?: Record<string, unknown> };
    expect(config.capabilities?.elicitation).toBeUndefined();
  });

  it("stays form-only with no accept-list and with an unknown version", () => {
    const noList = withLocalMrtrElicitationCapability({
      url: new URL("https://example.test/mcp"),
    } as never) as { capabilities?: Record<string, unknown> };
    expect(noList.capabilities?.elicitation).toBeUndefined();

    const bogus = withLocalMrtrElicitationCapability({
      url: new URL("https://example.test/mcp"),
      supportedProtocolVersions: ["2099-01-01"],
    } as never) as { capabilities?: Record<string, unknown> };
    expect(bogus.capabilities?.elicitation).toBeUndefined();
  });

  it("leaves an exact client capability set untouched", () => {
    // A host profile pins exactly what that host advertises; widening it would
    // defeat the point of the pin.
    const exact = { elicitation: {} };
    const config = withLocalMrtrElicitationCapability({
      url: new URL("https://example.test/mcp"),
      supportedProtocolVersions: modern,
      clientCapabilities: exact,
    } as never) as {
      clientCapabilities?: Record<string, unknown>;
      capabilities?: Record<string, unknown>;
    };
    expect(config.clientCapabilities).toBe(exact);
    expect(config.capabilities?.elicitation).toBeUndefined();
  });

  it("preserves other declared capabilities", () => {
    const config = withLocalMrtrElicitationCapability({
      url: new URL("https://example.test/mcp"),
      supportedProtocolVersions: modern,
      capabilities: { roots: { listChanged: true } },
    } as never) as { capabilities?: Record<string, unknown> };
    expect(config.capabilities?.roots).toEqual({ listChanged: true });
    expect(config.capabilities?.elicitation).toEqual({ form: {}, url: {} });
  });
});
