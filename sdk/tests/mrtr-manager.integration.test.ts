import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import type {
  InputRequests,
  MrtrInputCollector,
} from "../src/mcp-client-manager/index.js";
import {
  createMrtrFixtureHandler,
  MRTR_RESOURCE_URI,
} from "./support/mrtr-fixture.js";

/**
 * End-to-end: the real `MCPClientManager` drives the manual multi-round-trip
 * (`input_required`) loop against a conformant modern (2026-07-28) server over
 * a real loopback HTTP port. Proves the three verbs enter the loop, collect
 * input, and complete on retry — through the manager's actual sender wiring
 * (tool via `requestWithSchema` + reconstructed output validation, resource via
 * `readResource` cache path, prompt via the explicit-schema seam). Also locks
 * the advertise=enforce invariant: roots/sampling stay unadvertised under MRTR.
 */

interface ServedFixture {
  url: string;
  close: () => Promise<void>;
}

async function serveFixture(): Promise<ServedFixture> {
  const handler = createMrtrFixtureHandler();
  const httpServer = http.createServer(toNodeHandler(handler));
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

/** A collector that accepts every embedded request with a fixed answer. */
function acceptAllCollector(answer = "yes"): MrtrInputCollector {
  return async ({ inputRequests }: { inputRequests: InputRequests }) => {
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(inputRequests)) {
      out[key] = { action: "accept", content: { answer } };
    }
    return out;
  };
}

describe("MCPClientManager × modern MRTR fixture over HTTP", () => {
  let served: ServedFixture;
  let manager: MCPClientManager;

  async function connect(): Promise<void> {
    await manager.connectToServer("fixture", {
      url: served.url,
      mcpProtocolVersion: "2026-07-28",
      timeout: 10_000,
    });
  }

  beforeEach(async () => {
    served = await serveFixture();
    manager = new MCPClientManager();
    // The server checks the request's declared client capabilities before it
    // embeds an elicitation; register the collector BEFORE connect so
    // `elicitation` is advertised on the per-request envelope.
    manager.setMrtrInputCollector("fixture", acceptAllCollector());
  });

  afterEach(async () => {
    await manager.disconnectAllServers().catch(() => {});
    await served.close();
  });

  it("advertises elicitation (collector present) but never roots/sampling", async () => {
    await connect();
    const info = manager.getInitializationInfo("fixture");
    const caps = (info?.clientCapabilities ?? {}) as Record<string, unknown>;
    expect(caps.elicitation).toBeDefined();
    expect(caps.roots).toBeUndefined();
    expect(caps.sampling).toBeUndefined();
  });

  it("drives a tool call through an input_required round to completion", async () => {
    const collect = vi.fn(acceptAllCollector("apples"));
    manager.setMrtrInputCollector("fixture", collect);
    await connect();
    const result = (await manager.executeTool("fixture", "confirm", {
      topic: "fruit",
    })) as { content: Array<{ text?: string }> };
    expect(result.content[0]?.text).toBe("answer:apples");
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it("reconstructs tool output-schema validation on the final result", async () => {
    manager.setMrtrInputCollector("fixture", acceptAllCollector("typed-ok"));
    await connect();
    const result = (await manager.executeTool("fixture", "confirm-typed", {
      topic: "x",
    })) as { structuredContent?: { answer?: string } };
    // Completes without the reconstructed validator falsely rejecting valid
    // structured content that matches the tool's outputSchema.
    expect(result.structuredContent?.answer).toBe("typed-ok");
  });

  it("drives a prompt get through an input_required round", async () => {
    manager.setMrtrInputCollector("fixture", acceptAllCollector("p-ans"));
    await connect();
    const result = (await manager.getPrompt("fixture", {
      name: "confirm-prompt",
      arguments: { topic: "x" },
    })) as { messages: Array<{ content: { text?: string } }> };
    expect(result.messages[0]?.content.text).toBe("prompt:p-ans");
  });

  it("drives a resource read through an input_required round (cache path preserved)", async () => {
    manager.setMrtrInputCollector("fixture", acceptAllCollector("r-ans"));
    await connect();
    const result = (await manager.readResource("fixture", {
      uri: MRTR_RESOURCE_URI,
    })) as { contents: Array<{ text?: string }> };
    expect(result.contents[0]?.text).toBe("resource:r-ans");
  });

  it("leaves the non-MRTR path unchanged when no collector is registered", async () => {
    // Without a collector, elicitation is NOT advertised (advertise=enforce), so
    // the conformant modern server refuses to embed the elicitation request and
    // rejects with the typed "missing required client capability" protocol error
    // (-32021) rather than any unrelated failure. Assert on that specific error
    // so a regression that silently mishandles the no-collector path is caught.
    manager.clearMrtrInputCollector("fixture");
    await connect();
    const error = await manager
      .executeTool("fixture", "confirm", { topic: "x" })
      .then(() => undefined, (e: unknown) => e);
    expect((error as { code?: number })?.code).toBe(-32021);
    expect((error as { message?: string })?.message).toMatch(
      /client capabilities do not declare/i,
    );
  });
});

describe("post-negotiation capability re-resolution (eraCapabilities.modern)", () => {
  let served: ServedFixture;
  let manager: MCPClientManager;

  beforeEach(async () => {
    served = await serveFixture();
    manager = new MCPClientManager();
  });

  afterEach(async () => {
    await manager.disconnectAllServers().catch(() => {});
    await served.close();
  });

  it("applies the overlay after AUTO negotiation lands modern (url-mode elicitation)", async () => {
    // The bug this seam fixes: capabilities resolve at connect time, before
    // the era is known, so an UNPINNED connection had to advertise the
    // conservative form-only set even when auto-negotiation then landed on
    // 2026-07-28 — and every url-mode elicitation died at the server's
    // mode-aware capability gate (-32021). The overlay is applied once the
    // era is classified, so the same unpinned connection now declares
    // `{form, url}` on every post-negotiation request envelope.
    manager.setMrtrInputCollector("fixture", acceptAllCollector());
    await manager.connectToServer("fixture", {
      url: served.url,
      // NO mcpProtocolVersion pin — auto era negotiation.
      timeout: 10_000,
      eraCapabilities: { modern: { elicitation: { form: {}, url: {} } } },
    });

    const info = manager.getInitializationInfo("fixture");
    const caps = (info?.clientCapabilities ?? {}) as Record<string, unknown>;
    expect(caps.elicitation).toEqual({ form: {}, url: {} });

    const result = (await manager.executeTool("fixture", "confirm-url", {
      topic: "x",
    })) as { content: Array<{ text?: string }> };
    expect(result.content[0]?.text).toBe("consent:accept");
  });

  it("without the overlay, an auto-negotiated url-mode elicitation still fails closed", async () => {
    // Locks the baseline the seam widens FROM: a bare `elicitation: {}`
    // declaration is form-only under the spec's back-compat rule, so the
    // server refuses to embed a url-mode request (-32021). If this ever
    // starts passing, the conservative base has silently widened.
    manager.setMrtrInputCollector("fixture", acceptAllCollector());
    await manager.connectToServer("fixture", {
      url: served.url,
      timeout: 10_000,
    });
    const error = await manager
      .executeTool("fixture", "confirm-url", { topic: "x" })
      .then(() => undefined, (e: unknown) => e);
    expect((error as { code?: number })?.code).toBe(-32021);
  });

  it("ignores the overlay for an EXACT clientCapabilities set", async () => {
    // Pinning an exact set means exactly that — the era overlay must not
    // widen it, or the pin stops being a pin.
    manager.setMrtrInputCollector("fixture", acceptAllCollector());
    await manager.connectToServer("fixture", {
      url: served.url,
      timeout: 10_000,
      clientCapabilities: { elicitation: {} },
      eraCapabilities: { modern: { elicitation: { form: {}, url: {} } } },
    });

    const info = manager.getInitializationInfo("fixture");
    const caps = (info?.clientCapabilities ?? {}) as Record<string, unknown>;
    expect(caps.elicitation).toEqual({});

    const error = await manager
      .executeTool("fixture", "confirm-url", { topic: "x" })
      .then(() => undefined, (e: unknown) => e);
    expect((error as { code?: number })?.code).toBe(-32021);
  });

  it("gates the overlay's elicitation on a registered fulfiller (advertise=enforce)", async () => {
    // An overlay must not smuggle `elicitation` past the runtime gate: with
    // no collector and no handler, the widened set still advertises none.
    await manager.connectToServer("fixture", {
      url: served.url,
      timeout: 10_000,
      eraCapabilities: { modern: { elicitation: { form: {}, url: {} } } },
    });
    const info = manager.getInitializationInfo("fixture");
    const caps = (info?.clientCapabilities ?? {}) as Record<string, unknown>;
    expect(caps.elicitation).toBeUndefined();
  });

  it("also applies the overlay on a PINNED modern connection", async () => {
    // The seam keys on the classified era, not on how the era was selected —
    // a pin and a successful auto probe land in the same place.
    manager.setMrtrInputCollector("fixture", acceptAllCollector());
    await manager.connectToServer("fixture", {
      url: served.url,
      mcpProtocolVersion: "2026-07-28",
      timeout: 10_000,
      eraCapabilities: { modern: { elicitation: { form: {}, url: {} } } },
    });
    const result = (await manager.executeTool("fixture", "confirm-url", {
      topic: "x",
    })) as { content: Array<{ text?: string }> };
    expect(result.content[0]?.text).toBe("consent:accept");
  });
});
