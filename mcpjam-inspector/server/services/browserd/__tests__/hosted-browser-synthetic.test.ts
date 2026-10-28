/**
 * The synthetic check's orchestration: each stage's failure is reported under
 * that stage, and the desktop is deleted whatever happened. A run that leaked
 * a desktop would bill an awake machine every hour, so every failure case
 * below asserts the teardown as well as the stage.
 */
import { describe, expect, it, vi } from "vitest";
import {
  runHostedBrowserSynthetic,
  type SyntheticDeps,
  type SyntheticPage,
} from "../hosted-browser-synthetic";

const URL = "https://inspector.test/synthetic/webmcp";

function makeDeps(
  over: Partial<SyntheticDeps> & {
    open?: (url: string) => Promise<SyntheticPage>;
    counts?: number[];
  } = {},
) {
  const counts = over.counts ?? [1];
  let read = 0;
  const page: SyntheticPage = {
    countTools: vi.fn(async () => counts[Math.min(read++, counts.length - 1)]),
    close: vi.fn(async () => {}),
  };
  const open = vi.fn(over.open ?? (async () => page));
  const deps: SyntheticDeps = {
    reserve: over.reserve ?? vi.fn(async () => {}),
    boot: over.boot ?? vi.fn(async () => ({ open })),
    teardown: over.teardown ?? vi.fn(async () => {}),
    sleep: async () => {},
  };
  return { deps, page, open };
}

const fail = (message: string) => async () => {
  throw new Error(message);
};

describe("runHostedBrowserSynthetic", () => {
  it("passes when the page lists a tool, and still deletes the desktop", async () => {
    const { deps, page, open } = makeDeps();

    const result = await runHostedBrowserSynthetic(deps, { url: URL });

    expect(result).toMatchObject({ ok: true, stage: "complete", toolCount: 1 });
    expect(result.error).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(open).toHaveBeenCalledWith(URL);
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(deps.teardown).toHaveBeenCalledTimes(1);
  });

  it("re-reads an empty list until the page's script has registered", async () => {
    const { deps, page } = makeDeps({ counts: [0, 0, 2] });

    const result = await runHostedBrowserSynthetic(deps, { url: URL });

    expect(result).toMatchObject({ ok: true, toolCount: 2 });
    expect(page.countTools).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["reserve", { reserve: fail("reserve failed (503): at capacity") }],
    ["boot", { boot: fail("browserd did not come up") }],
    ["open", { open: fail("the browser rejected the command (busy)") }],
  ] as const)(
    "reports a %s failure under that stage and deletes the desktop",
    async (stage, over) => {
      const { deps, page } = makeDeps(over);

      const result = await runHostedBrowserSynthetic(deps, { url: URL });

      expect(result).toMatchObject({ ok: false, stage, toolCount: 0 });
      expect(result.error).toMatch(/reserve failed|browserd|rejected/);
      expect(deps.teardown).toHaveBeenCalledTimes(1);
      // Nothing was opened, so there is no page handle to release.
      expect(page.close).not.toHaveBeenCalled();
    },
  );

  it("fails at tools when the page registers none, and deletes the desktop", async () => {
    const { deps, page } = makeDeps({ counts: [0] });

    const result = await runHostedBrowserSynthetic(deps, {
      url: URL,
      toolWaitMs: 0,
    });

    expect(result).toMatchObject({
      ok: false,
      stage: "tools",
      toolCount: 0,
      error: "the page loaded but registered no WebMCP tools",
    });
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(deps.teardown).toHaveBeenCalledTimes(1);
  });

  it("fails at tools when the tool read itself fails", async () => {
    const { deps, page } = makeDeps();
    vi.mocked(page.countTools).mockRejectedValue(new Error("observe refused"));

    const result = await runHostedBrowserSynthetic(deps, { url: URL });

    expect(result).toMatchObject({ ok: false, stage: "tools" });
    expect(result.error).toContain("observe refused");
    expect(deps.teardown).toHaveBeenCalledTimes(1);
  });

  it("reports a passing run whose delete failed as a teardown failure", async () => {
    const { deps } = makeDeps({ teardown: fail("delete refused (403)") });

    const result = await runHostedBrowserSynthetic(deps, { url: URL });

    expect(result).toMatchObject({
      ok: false,
      stage: "teardown",
      toolCount: 1,
    });
    expect(result.error).toContain("delete refused");
  });

  it("keeps the first failure's stage when the teardown also fails", async () => {
    const { deps } = makeDeps({
      boot: fail("browserd did not come up"),
      teardown: fail("delete refused"),
    });

    const result = await runHostedBrowserSynthetic(deps, { url: URL });

    expect(result.stage).toBe("boot");
    expect(result.error).toContain("browserd did not come up");
    expect(result.error).toContain("teardown also failed: delete refused");
  });

  it("still deletes the desktop when closing the page fails", async () => {
    const { deps, page } = makeDeps();
    vi.mocked(page.close).mockRejectedValue(new Error("hub closed"));

    const result = await runHostedBrowserSynthetic(deps, { url: URL });

    expect(result.ok).toBe(true);
    expect(deps.teardown).toHaveBeenCalledTimes(1);
  });

  it("times out a stage that never settles, names it, and deletes the desktop", async () => {
    const boot = vi.fn(
      (signal: AbortSignal) =>
        new Promise<never>(() => {
          // Hangs, as a wedged provision would; only the deadline ends it.
          expect(signal.aborted).toBe(false);
        }),
    );
    const { deps } = makeDeps({ boot });

    const result = await runHostedBrowserSynthetic(deps, {
      url: URL,
      timeoutMs: 20,
    });

    expect(result).toMatchObject({ ok: false, stage: "boot" });
    expect(result.error).toMatch(/did not finish within/);
    expect(boot.mock.calls[0][0].aborted).toBe(true);
    expect(deps.teardown).toHaveBeenCalledTimes(1);
  });

  it("bounds a teardown that hangs", async () => {
    const { deps } = makeDeps({ teardown: () => new Promise<never>(() => {}) });

    const result = await runHostedBrowserSynthetic(deps, {
      url: URL,
      teardownTimeoutMs: 20,
    });

    expect(result).toMatchObject({ ok: false, stage: "teardown" });
    expect(result.error).toMatch(/teardown did not finish within/);
  });
});
