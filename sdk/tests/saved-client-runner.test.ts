import { afterEach, describe, expect, it, vi } from "vitest";
import * as receipts from "../src/eval-reporting-receipt.js";
import { EvalSuite } from "../src/EvalSuite.js";
import { EvalTest } from "../src/EvalTest.js";
import { PlatformApiClient } from "../src/platform/client.js";
import { createSavedClientRunner } from "../src/saved-client-runner.js";
import {
  buildReportingBody,
  snapshotReportingInput,
} from "../src/eval-reporting-config.js";
import type { MCPClientManager } from "../src/mcp-client-manager/MCPClientManager.js";

const detail = () => ({
  id: "client1",
  name: "My client",
  configId: "config1",
  versionId: "version1",
  versionNumber: 1,
  ownerScope: null,
  config: {
    hostStyle: "claude",
    modelId: "anthropic/claude-haiku-4.5",
    systemPrompt: "original prompt",
    temperature: 0.4,
    requireToolApproval: false,
    respectToolVisibility: true,
    serverIds: ["cloud-server"],
    clientCapabilities: {},
    hostContext: {},
    connectionDefaults: {},
  },
});
const manager = () =>
  ({
    listServers: () => ["local-server"],
    getConnectionStatus: vi.fn(() => "connected"),
    getToolsForAiSdk: vi.fn(async () => ({})),
    getServerReplayConfigs: () => [],
  }) as unknown as MCPClientManager;
const input = () => ({
  client: "My client",
  projectId: "project1",
  apiKey: "sk_test",
  manager: manager(),
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("latest saved client SDK runs", () => {
  it("resolves once per run and freezes all iterations, then fetches latest on the next run", async () => {
    const saved = detail();
    const fetch = vi
      .spyOn(PlatformApiClient.prototype, "getClient")
      .mockImplementation(async () => structuredClone(saved));
    const snapshots: unknown[] = [];
    const suite = new EvalSuite({
      defaults: { iterations: 1 },
      mcpjam: { enabled: false },
    });
    suite.add(
      new EvalTest({
        id: "client_case",
        name: "client case",
        test: async (executor) => {
          snapshots.push(executor.getHostSnapshot?.());
          saved.config.systemPrompt = "edited prompt";
          saved.versionNumber = 2;
          saved.versionId = "version2";
          return true;
        },
      })
    );
    await suite.runWithClient(input(), { iterations: 2 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(snapshots).toHaveLength(2);
    for (const snapshot of snapshots)
      expect(snapshot).toMatchObject({
        systemPrompt: "original prompt",
        model: "mcpjam/anthropic/claude-haiku-4.5",
        servers: ["local-server"],
      });
    await suite.runWithClient(input(), { iterations: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(snapshots[2]).toMatchObject({ systemPrompt: "edited prompt" });
  });

  it("keeps selected identity separate from the effective snapshot and sends it in reporting", async () => {
    vi.spyOn(PlatformApiClient.prototype, "getClient").mockResolvedValue(
      detail()
    );
    const { executor, selectedClient } = await createSavedClientRunner(
      input(),
      new AbortController().signal
    );
    expect(selectedClient).toEqual({
      id: "client1",
      name: "My client",
      configId: "config1",
      versionId: "version1",
      versionNumber: 1,
    });
    expect(executor.getHostSnapshot()?.servers).toEqual(["local-server"]);
    const reporting = snapshotReportingInput({ selectedClient });
    selectedClient.name = "changed after capture";
    expect(buildReportingBody(reporting).selectedClient).toMatchObject({
      name: "My client",
      versionNumber: 1,
    });
  });

  it("falls back from a saved empty prompt, and applies tool visibility policy", async () => {
    const saved = detail();
    saved.config.systemPrompt = "";
    saved.config.respectToolVisibility = false;
    vi.spyOn(PlatformApiClient.prototype, "getClient").mockResolvedValue(saved);
    const options = input();
    const { executor } = await createSavedClientRunner(
      options,
      new AbortController().signal
    );
    // Anthropic refuses an empty system block with a 400, so a client saved
    // without a system prompt has to run on the default one.
    expect(executor.getSystemPrompt()).toBe("You are a helpful assistant.");
    expect(options.manager.getToolsForAiSdk).toHaveBeenCalledWith(
      ["local-server"],
      expect.objectContaining({ includeAppOnly: true })
    );
  });

  it("ignores the project local-browser availability preference", async () => {
    vi.spyOn(PlatformApiClient.prototype, "getClient").mockResolvedValue({
      ...detail(),
      config: { ...detail().config, localBrowserEnabled: true },
    });
    const { executor } = await createSavedClientRunner(
      input(),
      new AbortController().signal
    );
    expect(executor.getHostSnapshot()?.localBrowserEnabled).not.toBe(true);
  });

  it.each([
    { iterations: 0 },
    { concurrency: 0 },
    { timeoutMs: -1 },
    { retries: -1 },
  ])("rejects invalid options before fetching: %j", async (options) => {
    const fetch = vi.spyOn(PlatformApiClient.prototype, "getClient");
    const selected = input();
    await expect(
      new EvalSuite({ defaults: { iterations: 1 } }).runWithClient(
        selected,
        options
      )
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(selected.manager.getToolsForAiSdk).not.toHaveBeenCalled();
  });

  it.each(["suite", "options", "selection"])(
    "uses the %s origin for setup and reporting",
    async (level) => {
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify(detail()), { status: 200 })
        );
      const report = vi
        .spyOn(receipts, "captureEvalReporting")
        .mockResolvedValue({
          receipt: receipts.notRequestedReceipt("disabled"),
        });
      const suite = new EvalSuite({
        defaults: { iterations: 1 },
        mcpjam: { baseUrl: "https://suite.example" },
      });
      suite.add(
        new EvalTest({ id: "case", name: "case", test: async () => true })
      );
      await suite.runWithClient(
        {
          ...input(),
          ...(level === "selection"
            ? { baseUrl: "https://selection.example" }
            : {}),
        },
        level === "suite"
          ? {}
          : { mcpjam: { baseUrl: "https://options.example" } }
      );
      expect(String(fetch.mock.calls[0][0])).toContain(
        `https://${level}.example/api/v1/`
      );
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: `https://${level}.example` })
      );
    }
  );

  it("rejects a backend without saved version support", async () => {
    vi.spyOn(PlatformApiClient.prototype, "getClient").mockResolvedValue({
      ...detail(),
      versionId: undefined,
      versionNumber: undefined,
    });
    await expect(
      new EvalSuite({ defaults: { iterations: 1 } }).runWithClient(input())
    ).rejects.toThrow("no recorded version");
  });

  it("passes the frozen client and selected project to suite reporting", async () => {
    vi.spyOn(PlatformApiClient.prototype, "getClient").mockResolvedValue(
      detail()
    );
    const report = vi
      .spyOn(receipts, "captureEvalReporting")
      .mockResolvedValue({ receipt: receipts.notRequestedReceipt("disabled") });
    const suite = new EvalSuite({
      name: "client suite",
      mcpjam: { ci: { provider: "custom" } },
    });
    suite.add(
      new EvalTest({ id: "client_case", name: "case", test: async () => true })
    );
    await suite.runWithClient(input(), { iterations: 1 });
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "project1",
        apiKey: "sk_test",
        selectedClient: expect.objectContaining({
          name: "My client",
          versionNumber: 1,
        }),
      })
    );
  });

  it("bounds tool setup and does not execute after cancellation", async () => {
    vi.useFakeTimers();
    vi.spyOn(PlatformApiClient.prototype, "getClient").mockResolvedValue(
      detail()
    );
    const options = input();
    vi.mocked(options.manager.getToolsForAiSdk).mockImplementation(
      () => new Promise(() => {})
    );
    const suite = new EvalSuite({
      defaults: { iterations: 1 },
      mcpjam: { enabled: false },
    });
    const pending = suite.runWithClient(options, { runTimeoutMs: 25 });
    const check = expect(pending).rejects.toThrow("Suite deadline exceeded");
    await vi.advanceTimersByTimeAsync(25);
    await check;
  });

  it.each([
    { computer: { id: "computer" } },
    { browserProfileId: "browser-profile" },
    { harness: "claude-code" },
    { requireToolApproval: true },
    { progressiveToolDiscovery: true },
    { builtInToolIds: ["web_search"] },
    { skillSelection: { mode: "explicit", skillIds: ["skill1"] } },
    { modelId: "google/gemini" },
    { modelId: "openai/gpt-4o" },
    { modelId: "anthropic/unknown" },
  ])("rejects unsupported settings before executing: %j", async (patch) => {
    vi.spyOn(PlatformApiClient.prototype, "getClient").mockResolvedValue({
      ...detail(),
      config: { ...detail().config, ...patch },
    });
    const test = vi.fn(async () => true);
    const suite = new EvalSuite({
      defaults: { iterations: 1 },
      mcpjam: { enabled: false },
    });
    suite.add(new EvalTest({ id: "client_case", name: "client case", test }));
    await expect(suite.runWithClient(input())).rejects.toThrow(
      /unsupported|supports/
    );
    expect(test).not.toHaveBeenCalled();
  });

  it("requires the code's servers to be connected", async () => {
    vi.spyOn(PlatformApiClient.prototype, "getClient").mockResolvedValue(
      detail()
    );
    const options = input();
    vi.mocked(options.manager.getConnectionStatus).mockReturnValue(
      "disconnected"
    );
    await expect(
      new EvalSuite({ defaults: { iterations: 1 } }).runWithClient(options)
    ).rejects.toThrow('Connect MCP server "local-server"');
  });

  it.each(["Client not found", "Access denied"])(
    "propagates resolution errors: %s",
    async (message) => {
      vi.spyOn(PlatformApiClient.prototype, "getClient").mockRejectedValue(
        new Error(message)
      );
      await expect(
        new EvalSuite({ defaults: { iterations: 1 } }).runWithClient(input())
      ).rejects.toThrow(message);
    }
  );

  it("includes a stalled client fetch in the run timeout and clears the running lock", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .spyOn(PlatformApiClient.prototype, "getClient")
      .mockImplementation(() => new Promise(() => {}));
    const suite = new EvalSuite({
      defaults: { iterations: 1 },
      mcpjam: { enabled: false },
    });
    const pending = suite.runWithClient(input(), { runTimeoutMs: 25 });
    const check = expect(pending).rejects.toThrow("Suite deadline exceeded");
    await vi.advanceTimersByTimeAsync(25);
    await check;
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    fetch.mockRejectedValue(new Error("next run started"));
    await expect(suite.runWithClient(input())).rejects.toThrow(
      "next run started"
    );
  });

  it("cancels setup and refuses an overlapping run", async () => {
    vi.spyOn(PlatformApiClient.prototype, "getClient").mockImplementation(
      () => new Promise(() => {})
    );
    const controller = new AbortController();
    const suite = new EvalSuite({ defaults: { iterations: 1 } });
    const pending = suite.runWithClient(input(), { signal: controller.signal });
    await expect(suite.runWithClient(input())).rejects.toThrow(
      "already running"
    );
    const check = expect(pending).rejects.toThrow("cancel setup");
    controller.abort(new Error("cancel setup"));
    await check;
  });

  it("does not fetch when already cancelled", async () => {
    const fetch = vi.spyOn(PlatformApiClient.prototype, "getClient");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      new EvalSuite({ defaults: { iterations: 1 } }).runWithClient(input(), {
        signal: controller.signal,
      })
    ).rejects.toThrow("cancelled");
    expect(fetch).not.toHaveBeenCalled();
  });
});
