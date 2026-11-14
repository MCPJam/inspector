import { afterEach, describe, expect, it, vi } from "vitest";
import { MCPConformanceTest } from "../../src/mcp-conformance/runner.js";
import { MCPAppsConformanceTest } from "../../src/apps-conformance/runner.js";
import { MCPClientManager } from "../../src/mcp-client-manager/index.js";
import { withEphemeralClient } from "../../src/operations.js";
import { startConformanceMockServer } from "../mock-servers/conformance-mcp-server.js";

afterEach(() => vi.restoreAllMocks());

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve: (value: T) => resolve(value) };
}

function pendingRequest(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
  });
}

describe("conformance cancellation", () => {
  it.each(["protocol", "apps"] as const)(
    "cancels %s connection setup and closes the client",
    async (suite) => {
      const started = deferred<AbortSignal>();
      const controller = new AbortController();
      const reason = new Error("Hosted deadline expired");
      const cleanup = vi.spyOn(
        MCPClientManager.prototype,
        "disconnectAllServers"
      );
      const fetchFn: typeof fetch = async (_input, init) => {
        const signal = init?.signal;
        if (!signal) throw new Error("Missing request signal");
        started.resolve(signal);
        return pendingRequest(signal);
      };
      const run =
        suite === "protocol"
          ? new MCPConformanceTest({
              serverUrl: "https://example.com/mcp",
              signal: controller.signal,
              fetchFn,
            }).run()
          : new MCPAppsConformanceTest({
              url: "https://example.com/mcp",
              signal: controller.signal,
              baseFetch: fetchFn,
            }).run();
      const rejected = expect(run).rejects.toBe(reason);
      const activeSignal = await started.promise;
      controller.abort(reason);
      await rejected;
      expect(activeSignal.aborted).toBe(true);
      expect(cleanup).toHaveBeenCalledTimes(1);
    }
  );

  it("aborts concurrent raw protocol probes and starts no later requests", async () => {
    const controller = new AbortController();
    const started = deferred<void>();
    const signals: AbortSignal[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Missing request signal");
      signals.push(signal);
      if (signals.length === 2) started.resolve();
      return pendingRequest(signal);
    });
    const reason = new Error("Hosted deadline expired");
    const run = new MCPConformanceTest({
      serverUrl: "https://example.com/mcp",
      protocolVersion: "2025-11-25",
      signal: controller.signal,
      fetchFn,
      readinessIds: [],
      checkIds: ["protocol-invalid-method-error", "post-response-content-type"],
    }).run();
    const rejected = expect(run).rejects.toBe(reason);
    await started.promise;
    controller.abort(reason);
    await rejected;
    await Promise.resolve();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("cancels Apps resource reads and closes the owned connection", async () => {
    const server = await startConformanceMockServer();
    const controller = new AbortController();
    const started = deferred<AbortSignal>();
    const reason = new Error("Hosted deadline expired");
    const cleanup = vi.spyOn(
      MCPClientManager.prototype,
      "disconnectAllServers"
    );
    vi.spyOn(MCPClientManager.prototype, "readResource").mockImplementation(
      async (_serverId, _params, options) => {
        const signal = options?.signal;
        if (!signal) throw new Error("Missing resource signal");
        started.resolve(signal);
        return pendingRequest(signal);
      }
    );
    try {
      const run = new MCPAppsConformanceTest({
        url: server.url,
        signal: controller.signal,
      }).run();
      const rejected = expect(run).rejects.toBe(reason);
      const activeSignal = await started.promise;
      controller.abort(reason);
      await rejected;
      expect(activeSignal.aborted).toBe(true);
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      await server.stop();
    }
  });

  it("does not start Apps discovery after its first listing is cancelled", async () => {
    const server = await startConformanceMockServer();
    const controller = new AbortController();
    const started = deferred<void>();
    const reason = new Error("Hosted deadline expired");
    const resources = vi.spyOn(MCPClientManager.prototype, "listResources");
    vi.spyOn(MCPClientManager.prototype, "listTools").mockImplementation(
      async (_serverId, _params, options) => {
        const signal = options?.signal;
        if (!signal) throw new Error("Missing listing signal");
        started.resolve();
        return pendingRequest(signal);
      }
    );
    try {
      const run = new MCPAppsConformanceTest({
        url: server.url,
        signal: controller.signal,
      }).run();
      const rejected = expect(run).rejects.toBe(reason);
      await started.promise;
      controller.abort(reason);
      await rejected;
      expect(resources).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("does not connect after cancelled setup resumes", async () => {
    const ready = deferred<void>();
    const started = deferred<void>();
    const connect = vi
      .spyOn(MCPClientManager.prototype, "connectToServer")
      .mockRejectedValue(new Error("Must not connect after cancellation"));
    const cleanup = vi
      .spyOn(MCPClientManager.prototype, "disconnectAllServers")
      .mockResolvedValue();
    const controller = new AbortController();
    const reason = new Error("Hosted deadline expired");
    const callback = vi.fn();
    const run = withEphemeralClient(
      { url: "https://example.com/mcp" },
      callback,
      {
        signal: controller.signal,
        beforeConnect: async () => {
          started.resolve();
          await ready.promise;
        },
      }
    );
    const rejected = expect(run).rejects.toBe(reason);
    await started.promise;
    controller.abort(reason);
    await rejected;
    ready.resolve();
    await Promise.resolve();
    expect(connect).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
