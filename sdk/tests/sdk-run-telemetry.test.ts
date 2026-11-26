import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as telemetry from "../src/telemetry.js";
import { EvalTest } from "../src/EvalTest.js";
import { HostRunner } from "../src/HostRunner.js";
import { PromptResult } from "../src/PromptResult.js";
import type { MCPClientManager } from "../src/mcp-client-manager/index.js";
import { runEventsConformance } from "../src/events-conformance/runner.js";
import { runServerDoctor } from "../src/server-doctor.js";
import { runSuiteFile } from "../src/suite-file-run/run-suite-file.js";

/** Each started run, and the outcomes its `finish` was called with. */
let runs: Array<{
  entryPoint: telemetry.SdkRunEntryPoint;
  iterations?: number;
  outcomes: telemetry.SdkRunOutcome[];
}>;

beforeEach(() => {
  runs = [];
  vi.spyOn(telemetry, "startSdkRunTelemetry").mockImplementation(
    (entryPoint, options = {}) => {
      const run = {
        entryPoint,
        ...(options.iterations === undefined
          ? {}
          : { iterations: options.iterations }),
        outcomes: [] as telemetry.SdkRunOutcome[],
      };
      runs.push(run);
      return {
        async finish(outcome) {
          run.outcomes.push(outcome);
        },
      };
    }
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The outcome that counts: the first `finish` call. */
const firstOutcomes = () =>
  runs.map((run) => [run.entryPoint, run.outcomes[0]]);

const mockExecutor = () =>
  HostRunner.mock(async (prompt) =>
    PromptResult.from({
      prompt,
      messages: [
        { role: "user", content: prompt },
        { role: "assistant", content: "ok" },
      ],
      text: "ok",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      latency: { e2eMs: 1, llmMs: 1, mcpMs: 0 },
    })
  );

describe("EvalTest.run", () => {
  const evalTest = (passes: boolean) =>
    new EvalTest({ id: "c_telemetry", name: "telemetry", test: async () => passes });

  it("sends passed or failed with the iteration count", async () => {
    await evalTest(true).run(mockExecutor(), {
      iterations: 2,
      mcpjam: { enabled: false },
    });
    await evalTest(false).run(mockExecutor(), {
      iterations: 3,
      mcpjam: { enabled: false },
    });
    expect(firstOutcomes()).toEqual([
      ["eval_test", "passed"],
      ["eval_test", "failed"],
    ]);
    expect(runs.map((run) => run.iterations)).toEqual([2, 3]);
  });

  it("sends aborted for a cancelled run", async () => {
    const controller = new AbortController();
    controller.abort();
    await evalTest(true)
      .run(mockExecutor(), {
        iterations: 1,
        signal: controller.signal,
        mcpjam: { enabled: false },
      })
      .catch(() => undefined);
    expect(firstOutcomes()).toEqual([["eval_test", "aborted"]]);
  });

  it("starts nothing when a host suppresses telemetry", async () => {
    await evalTest(true).run(mockExecutor(), {
      iterations: 1,
      mcpjam: { enabled: false },
      __suppressTelemetry: true,
    });
    expect(runs).toEqual([]);
  });
});

describe("runSuiteFile", () => {
  it("sends one errored event for a file that cannot run", async () => {
    await expect(
      runSuiteFile("not: [a suite", { servers: {} })
    ).rejects.toThrow();
    expect(firstOutcomes()).toEqual([["suite_file", "errored"]]);
  });

  it("starts nothing for the CLI, which counts `mcpjam test` itself", async () => {
    await expect(
      runSuiteFile("not: [a suite", { servers: {}, surface: "cli" })
    ).rejects.toThrow();
    expect(runs).toEqual([]);
  });
});

describe("runServerDoctor", () => {
  const input = {
    config: { url: "https://example.com/mcp", timeout: 1_000 },
    target: { label: "example" },
    timeout: 1_000,
  };
  const unreachable = {
    probeServer: vi.fn().mockRejectedValue(new Error("unreachable")),
    withManager: async () => {
      throw new Error("unreachable");
    },
  };

  it("sends failed when the server isn't ready", async () => {
    const result = await runServerDoctor(input, unreachable);
    expect(result.status).not.toBe("ready");
    expect(firstOutcomes()).toEqual([["server_doctor", "failed"]]);
  });

  it("sends errored when the doctor throws", async () => {
    await expect(
      runServerDoctor({ ...input, config: { url: "", timeout: 1_000 } })
    ).rejects.toThrow();
    expect(firstOutcomes()).toEqual([["server_doctor", "errored"]]);
  });

  it("starts nothing when a host suppresses telemetry", async () => {
    await runServerDoctor({ ...input, __suppressTelemetry: true }, unreachable);
    expect(runs).toEqual([]);
  });
});

describe("runEventsConformance", () => {
  const manager = {} as MCPClientManager;

  it("sends one events conformance ping, and none when suppressed", async () => {
    const capture = vi
      .spyOn(telemetry, "captureConformanceRun")
      .mockResolvedValue();
    const run = (suppress: boolean) =>
      runEventsConformance({
        manager,
        serverId: "s",
        profile: "core",
        checkIds: [],
        ...(suppress ? { __suppressTelemetry: true } : {}),
      }).catch(() => undefined);

    await run(false);
    expect(capture.mock.calls).toEqual([
      ["sdk", { suite: "events", mode: "single" }],
    ]);
    capture.mockClear();
    await run(true);
    expect(capture).not.toHaveBeenCalled();
  });
});
