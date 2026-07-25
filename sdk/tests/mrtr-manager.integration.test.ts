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
    // A modern server returning input_required with no collector surfaces the
    // SDK's typed manual-mode error rather than silently mishandling it.
    manager.clearMrtrInputCollector("fixture");
    await connect();
    await expect(
      manager.executeTool("fixture", "confirm", { topic: "x" }),
    ).rejects.toBeTruthy();
  });
});
