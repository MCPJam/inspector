import { afterEach, describe, expect, it, vi } from "vitest";
import * as receipts from "../src/eval-reporting-receipt.js";
import { EvalSuite } from "../src/EvalSuite.js";
import { EvalTest } from "../src/EvalTest.js";
import { PlatformApiClient } from "../src/platform/client.js";
import {
  createSavedClientRunner,
  UnsupportedModelSelectionError,
} from "../src/saved-client-runner.js";
import {
  buildReportingBody,
  normalizeReportingConfig,
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
  } as unknown as MCPClientManager);
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

describe("runWithClient with several saved clients", () => {
  const clientNamed = (name: string, id: string) => ({
    ...detail(),
    id,
    name,
    configId: `${id}-config`,
    versionId: `${id}-v1`,
  });
  const byName = () =>
    vi
      .spyOn(PlatformApiClient.prototype, "getClient")
      .mockImplementation(async ({ client }) =>
        client === "Claude"
          ? clientNamed("Claude", "claude")
          : clientNamed("Astra", "astra")
      );
  const reportSpy = () =>
    vi
      .spyOn(receipts, "captureEvalReporting")
      .mockImplementation(async (input) => ({
        receipt: {
          schemaVersion: 1,
          state: "persisted",
          acceptedIterations: input.results.length,
          acknowledgedIterations: input.results.length,
          pendingIterations: 0,
        },
      }));
  const suiteWithCase = (
    config: ConstructorParameters<typeof EvalSuite>[0] = {}
  ) => {
    const suite = new EvalSuite({ defaults: { iterations: 1 }, ...config });
    suite.add(
      new EvalTest({ id: "client_case", name: "case", test: async () => true })
    );
    return suite;
  };

  it("uploads one run per client, all in one run group", async () => {
    const fetch = byName();
    const report = reportSpy();
    const result = await suiteWithCase().runWithClient({
      ...input(),
      client: ["Claude", "Astra"],
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(2);
    const bodies = report.mock.calls.map(([body]) => body);
    const groupIds = new Set(bodies.map((body) => body.runGroupId));
    expect(groupIds.size).toBe(1);
    expect(result.runGroupId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(bodies.map((body) => body.selectedClient?.name).sort()).toEqual([
      "Astra",
      "Claude",
    ]);
    expect(Object.keys(result.clients).sort()).toEqual(["Astra", "Claude"]);
    expect(result.clients.Claude.client.name).toBe("Claude");
    expect(result.clients.Claude.receipt.state).toBe("persisted");
    expect(result.failures).toEqual({});
    // The top level aggregates both clients.
    expect(result.aggregate.iterations).toBe(2);
    expect([...result.tests.keys()].sort()).toEqual([
      "Astra / case",
      "Claude / case",
    ]);
  });

  it("derives each client's run id from a caller's externalRunId", async () => {
    byName();
    const report = reportSpy();
    await suiteWithCase({ mcpjam: { externalRunId: "ci-42" } }).runWithClient({
      ...input(),
      client: ["Claude", "Astra"],
    });
    expect(
      report.mock.calls.map(([body]) => body.externalRunId).sort()
    ).toEqual(["ci-42:Astra", "ci-42:Claude"]);
  });

  it("keeps a caller-supplied run group id", async () => {
    byName();
    const report = reportSpy();
    const result = await suiteWithCase({
      mcpjam: { runGroupId: "launch-7" },
    }).runWithClient({ ...input(), client: ["Claude", "Astra"] });
    expect(result.runGroupId).toBe("launch-7");
    for (const [body] of report.mock.calls)
      expect(body.runGroupId).toBe("launch-7");
  });

  it("runs the clients in parallel", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started: string[] = [];
    vi.spyOn(PlatformApiClient.prototype, "getClient").mockImplementation(
      async ({ client }) => {
        started.push(client);
        await gate;
        return clientNamed(client, client.toLowerCase());
      }
    );
    reportSpy();
    const run = suiteWithCase().runWithClient({
      ...input(),
      client: ["Claude", "Astra"],
    });
    await vi.waitFor(() => expect(started).toHaveLength(2));
    release();
    await run;
  });

  it("does not let one client's failure cancel the others", async () => {
    vi.spyOn(PlatformApiClient.prototype, "getClient").mockImplementation(
      async ({ client }) => {
        if (client === "Missing") throw new Error("client not found");
        return clientNamed(client, client.toLowerCase());
      }
    );
    const report = reportSpy();
    const result = await suiteWithCase().runWithClient({
      ...input(),
      client: ["Claude", "Missing"],
    });
    expect(report).toHaveBeenCalledTimes(1);
    expect(Object.keys(result.clients)).toEqual(["Claude"]);
    expect(result.failures.Missing.client).toBe("Missing");
    expect(String(result.failures.Missing.error)).toContain("client not found");
  });

  it("throws when every client fails", async () => {
    vi.spyOn(PlatformApiClient.prototype, "getClient").mockRejectedValue(
      new Error("client not found")
    );
    const suite = suiteWithCase();
    await expect(
      suite.runWithClient({ ...input(), client: ["A", "B"] })
    ).rejects.toThrow("client not found");
    // The lock is released, so the suite can run again.
    byName();
    reportSpy();
    await expect(
      suite.runWithClient({ ...input(), client: ["Claude"] })
    ).resolves.toMatchObject({ clients: { Claude: expect.anything() } });
  });

  it("throws an AggregateError under strict when any client fails", async () => {
    vi.spyOn(PlatformApiClient.prototype, "getClient").mockImplementation(
      async ({ client }) => {
        if (client === "Missing") throw new Error("client not found");
        return clientNamed(client, client.toLowerCase());
      }
    );
    reportSpy();
    const suite = suiteWithCase({ mcpjam: { strict: true } });
    await expect(
      suite.runWithClient({ ...input(), client: ["Claude", "Missing"] })
    ).rejects.toBeInstanceOf(AggregateError);
    // The partial result is still readable.
    expect(suite.getResults()).toMatchObject({
      clients: { Claude: expect.anything() },
    });
  });

  it("combines the per-client receipts", async () => {
    byName();
    reportSpy();
    const suite = suiteWithCase();
    await suite.runWithClient({ ...input(), client: ["Claude", "Astra"] });
    expect(suite.getReportingReceipt()).toMatchObject({
      state: "persisted",
      acceptedIterations: 2,
      acknowledgedIterations: 2,
      pendingIterations: 0,
    });
  });

  it("gives each client its own copy of the cases", async () => {
    byName();
    reportSpy();
    const suite = suiteWithCase();
    await suite.runWithClient({ ...input(), client: ["Claude", "Astra"] });
    // The suite's own case never ran; each client ran a clone.
    expect(suite.get("case")!.getResults()).toBeNull();
  });

  it("leaves a single client exactly as before", async () => {
    vi.spyOn(PlatformApiClient.prototype, "getClient").mockResolvedValue(
      detail()
    );
    const report = reportSpy();
    const result = await suiteWithCase().runWithClient(input());
    expect(report.mock.calls[0][0]).not.toHaveProperty("runGroupId");
    expect(result).not.toHaveProperty("clients");
    expect(result).not.toHaveProperty("runGroupId");
  });

  it.each([
    [[], /at least one/],
    [["Claude", "Claude"], /Duplicate client/],
    [["Claude", " "], /non-empty/],
    [Array.from({ length: 11 }, (_, i) => `c${i}`), /at most 10/],
  ])("rejects a bad client list before fetching %#", async (clients, error) => {
    const fetch = vi.spyOn(PlatformApiClient.prototype, "getClient");
    await expect(
      suiteWithCase().runWithClient({ ...input(), client: clients })
    ).rejects.toThrow(error);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts every client on the run timeout and frees the suite", async () => {
    vi.spyOn(PlatformApiClient.prototype, "getClient").mockImplementation(
      () => new Promise(() => {})
    );
    const suite = suiteWithCase();
    await expect(
      suite.runWithClient(
        { ...input(), client: ["Claude", "Astra"] },
        { runTimeoutMs: 20 }
      )
    ).rejects.toThrow("Suite deadline exceeded");
    byName();
    reportSpy();
    await expect(
      suite.runWithClient({ ...input(), client: ["Claude"] })
    ).resolves.toBeDefined();
  });
});

describe("runGroupId on the reporting wire", () => {
  it("sends it in the reporting body", () => {
    expect(buildReportingBody({ runGroupId: "launch-7" })).toMatchObject({
      runGroupId: "launch-7",
    });
  });

  it.each(["", "  ", "x".repeat(129)])(
    "rejects a malformed id %#",
    (runGroupId) => {
      expect(() => normalizeReportingConfig({ runGroupId }, {})).toThrow(
        /runGroupId/
      );
    }
  );
});

describe("saved client model selection", () => {
  const modelId = "anthropic/claude-haiku-4.5";
  const withSelection = (modelSelection: unknown) => {
    const saved = detail();
    return {
      ...saved,
      config: { ...saved.config, modelSelection },
    };
  };
  const run = async () =>
    createSavedClientRunner(input(), new AbortController().signal);

  it("refuses an org selection with a typed error instead of running it as a bare id", async () => {
    vi.spyOn(PlatformApiClient.prototype, "getClient").mockResolvedValue(
      withSelection({
        modelId,
        source: "org",
        connectionRef: { kind: "orgProvider", id: "k17abc" },
        fallback: { provider: "none", model: "none" },
      })
    );
    const selected = input();
    const error = await createSavedClientRunner(
      selected,
      new AbortController().signal
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedModelSelectionError);
    expect(error).toMatchObject({ source: "org", modelId });
    expect(String((error as Error).message)).toContain('source "org"');
    expect(selected.manager.getToolsForAiSdk).not.toHaveBeenCalled();
  });

  it("refuses a local selection with a typed error", async () => {
    vi.spyOn(PlatformApiClient.prototype, "getClient").mockResolvedValue(
      withSelection({
        modelId,
        source: "local",
        connectionRef: { kind: "localProvider", providerKey: "anthropic" },
        fallback: { provider: "none", model: "none" },
      })
    );
    await expect(run()).rejects.toMatchObject({
      name: "UnsupportedModelSelectionError",
      source: "local",
    });
  });

  it("refuses the whole run through runWithClient too", async () => {
    vi.spyOn(PlatformApiClient.prototype, "getClient").mockResolvedValue(
      withSelection({
        modelId,
        source: "org",
        connectionRef: { kind: "orgProvider", id: "k17abc" },
        fallback: { provider: "none", model: "none" },
      })
    );
    await expect(
      new EvalSuite({
        defaults: { iterations: 1 },
        mcpjam: { enabled: false },
      }).runWithClient(input())
    ).rejects.toThrow(/source "org"/);
  });

  it("refuses a malformed selection rather than ignoring it", async () => {
    vi.spyOn(PlatformApiClient.prototype, "getClient").mockResolvedValue(
      withSelection({ modelId, source: "org" })
    );
    await expect(run()).rejects.toThrow(/hostConfigV2: modelSelection/);
  });

  it("refuses a hosted selection that names a different model than modelId", async () => {
    vi.spyOn(PlatformApiClient.prototype, "getClient").mockResolvedValue(
      withSelection({
        modelId: "openai/gpt-5",
        source: "hosted",
        fallback: { provider: "none", model: "none" },
      })
    );
    const selected = input();
    await expect(
      createSavedClientRunner(selected, new AbortController().signal)
    ).rejects.toThrow(
      `hostConfigV2: modelSelection.modelId ("openai/gpt-5") must equal modelId ("${modelId}")`
    );
    expect(selected.manager.getToolsForAiSdk).not.toHaveBeenCalled();
  });

  it("runs a hosted selection exactly like no selection", async () => {
    vi.spyOn(PlatformApiClient.prototype, "getClient").mockResolvedValue(
      detail()
    );
    const bare = (await run()).executor.getHostSnapshot();
    vi.restoreAllMocks();
    vi.spyOn(PlatformApiClient.prototype, "getClient").mockResolvedValue(
      withSelection({
        modelId,
        source: "hosted",
        fallback: { provider: "none", model: "none" },
      })
    );
    const hosted = (await run()).executor.getHostSnapshot();
    expect(hosted).toEqual(bare);
    expect(hosted).toMatchObject({ model: `mcpjam/${modelId}` });
    expect(JSON.stringify(hosted)).not.toContain("modelSelection");
  });

  it("leaves a client without a selection unchanged", async () => {
    vi.spyOn(PlatformApiClient.prototype, "getClient").mockResolvedValue(
      detail()
    );
    const snapshot = (await run()).executor.getHostSnapshot();
    expect(snapshot).toMatchObject({
      model: `mcpjam/${modelId}`,
      systemPrompt: "original prompt",
      temperature: 0.4,
    });
  });
});
