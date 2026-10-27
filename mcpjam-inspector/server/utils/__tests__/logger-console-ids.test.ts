import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

const mockIngest = vi.fn();
vi.mock("@axiomhq/js", () => ({
  Axiom: vi.fn().mockImplementation(function () {
    return { ingest: mockIngest, flush: vi.fn().mockResolvedValue(undefined) };
  }),
}));

type Logger = (typeof import("../logger.js"))["logger"];

async function loadLogger(env: Record<string, string>): Promise<Logger> {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return (await import("../logger.js")).logger;
}

/** Everything the console received, as one string, so a leak anywhere shows. */
function printed(...spies: ReturnType<typeof vi.spyOn>[]): string {
  return spies
    .flatMap((spy) => spy.mock.calls.flat())
    .map((arg) => (arg instanceof Error ? arg.message : JSON.stringify(arg)))
    .join("\n");
}

describe("logger console IDs", () => {
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    mockIngest.mockClear();
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("ties local swarm lines to their run and session with telemetry off", async () => {
    const logger = await loadLogger({ NODE_ENV: "development", DO_NOT_TRACK: "1" });

    logger.info("[swarm.runner] attempt.start", {
      runId: "jx7d2k9run",
      hostId: "host-1",
      targetId: "target-1",
      sessionIdx: 0,
      modelId: "openai/gpt-5.4-mini",
    });
    logger.warn("[sessionSimulation.runner] harness turn refused", {
      runId: "jx7d2k9run",
      chatSessionId: "synth_jx7d2k9run_p1_0",
      error: "provider refused the request",
    });

    expect(log).toHaveBeenCalledWith(
      "[swarm.runner] attempt.start runId=jx7d2k9run sessionIdx=0",
    );
    expect(warn).toHaveBeenCalledWith(
      "[sessionSimulation.runner] harness turn refused runId=jx7d2k9run chatSessionId=synth_jx7d2k9run_p1_0",
    );
  });

  it("prints every allowlisted ID in a fixed order", async () => {
    const logger = await loadLogger({ NODE_ENV: "development", DO_NOT_TRACK: "1" });

    logger.info("eval step", {
      requestId: "ab5fb35f-4604-4d5b-8724-fd2e69539cbe",
      promptIndex: 2,
      turnId: "turn:7",
      iterationId: "k57iteration",
      sessionIdx: 1,
      chatSessionId: "chat-1",
      sessionId: "session.1",
      runId: "run_1",
    });

    expect(log).toHaveBeenCalledWith(
      "eval step runId=run_1 sessionId=session.1 chatSessionId=chat-1 sessionIdx=1 iterationId=k57iteration turnId=turn:7 promptIndex=2 requestId=ab5fb35f-4604-4d5b-8724-fd2e69539cbe",
    );
  });

  it("never prints a context field outside the allowlist, nested ones included", async () => {
    const logger = await loadLogger({ NODE_ENV: "development", DO_NOT_TRACK: "1" });
    const context = {
      runId: "run_1",
      toolResult: { content: [{ type: "text", text: "SECRET tool output" }] },
      prompt: "SECRET user prompt",
      error: "SECRET provider message",
      serverUrl: "https://SECRET.example.com/mcp",
      // Allowlisted names one level down are still another field's content.
      meta: { sessionId: "SECRETnested", requestId: "SECRETnested2" },
      items: [{ turnId: "SECRETinArray" }],
    };

    logger.info("context check", context);
    logger.warn("context check", context);
    logger.error("context check", new Error("boom"), context);

    expect(log).toHaveBeenCalledWith("context check runId=run_1");
    expect(warn).toHaveBeenCalledWith("context check runId=run_1");
    expect(error).toHaveBeenCalledWith("context check runId=run_1", expect.any(Error));
    expect(printed(log, warn, error)).not.toContain("SECRET");
  });

  it("drops a value under an allowlisted key unless it is shaped like an ID", async () => {
    const logger = await loadLogger({ NODE_ENV: "development", DO_NOT_TRACK: "1" });

    logger.info("shape check", {
      runId: "SECRET two words",
      sessionId: "SECRET\nnext line",
      chatSessionId: "SECRET@example.com",
      iterationId: "https://example.com/SECRET",
      turnId: `SECRET${"x".repeat(128)}`,
      requestId: { id: "SECRETobject" },
      sessionIdx: -1,
      promptIndex: 1.5,
    });
    logger.info("shape check", {
      runId: ["SECRETarray"],
      sessionIdx: Number.NaN,
      promptIndex: Number.POSITIVE_INFINITY,
      turnId: "",
      iterationId: true,
      requestId: null,
    });

    expect(log).toHaveBeenNthCalledWith(1, "shape check");
    expect(log).toHaveBeenNthCalledWith(2, "shape check");
    expect(printed(log)).not.toContain("SECRET");
  });

  it("keeps logger.error's error argument after the IDs", async () => {
    const logger = await loadLogger({ NODE_ENV: "development", DO_NOT_TRACK: "1" });
    const failure = new Error("persist failed");

    logger.error("[swarm.runner] finalize failed", failure, {
      runId: "run_1",
      chatSessionId: "chat-1",
    });

    expect(error).toHaveBeenCalledWith(
      "[swarm.runner] finalize failed runId=run_1 chatSessionId=chat-1",
      failure,
    );
  });

  it("prints nothing in production unless verbose logging is on", async () => {
    const quiet = await loadLogger({ NODE_ENV: "production", DO_NOT_TRACK: "1" });
    quiet.info("quiet", { runId: "run_1" });
    quiet.warn("quiet", { runId: "run_1" });
    quiet.error("quiet", new Error("quiet"), { runId: "run_1" });
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();

    vi.resetModules();
    const verbose = await loadLogger({
      NODE_ENV: "production",
      DO_NOT_TRACK: "1",
      VERBOSE_LOGS: "true",
    });
    verbose.info("loud", { runId: "run_1" });
    expect(log).toHaveBeenCalledWith("loud runId=run_1");
  });

  it("leaves the Axiom row's message untouched", async () => {
    const logger = await loadLogger({
      NODE_ENV: "development",
      AXIOM_TOKEN: "test-token",
      AXIOM_CLEAN_DATASET: "test-dataset",
      DO_NOT_TRACK: "",
    });

    // Axiom classifies this line by its exact message; a suffixed message
    // would land as an uncatalogued row instead.
    logger.warn("[harness] turn failed", { runId: "run_1" });

    expect(warn).toHaveBeenCalledWith("[harness] turn failed runId=run_1");
    expect(mockIngest).toHaveBeenCalledWith("test-dataset", [
      expect.objectContaining({ event: "harness.turn.failed", level: "warn" }),
    ]);
    expect(JSON.stringify(mockIngest.mock.calls)).not.toContain("runId=run_1");
  });
});
