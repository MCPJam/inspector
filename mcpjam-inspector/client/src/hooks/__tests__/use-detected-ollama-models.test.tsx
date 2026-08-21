/**
 * `useDetectedOllamaModels` — the local-Ollama probe schedule.
 *
 * The regression these lock down: the hook probed 127.0.0.1:11434 on a flat
 * 30s setInterval that never stopped, in every tab, whether or not the user
 * had Ollama installed. Each probe of a closed port writes a connection error
 * the browser emits below the fetch promise, which no JS catch can swallow, so
 * an install without Ollama filled the console with noise every 30s forever.
 *
 * Backoff and the visibility pause fix that, and both regress quietly: the
 * failure modes are "probe on every visibilitychange" and "two chains polling
 * at once", neither of which changes what the hook returns.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  detectOllamaModels,
  detectOllamaToolCapableModels,
} from "@/lib/ollama-utils";
import { useDetectedOllamaModels } from "../use-detected-ollama-models";

vi.mock("@/lib/ollama-utils", () => ({
  detectOllamaModels: vi.fn(),
  detectOllamaToolCapableModels: vi.fn(),
}));

const detectModels = vi.mocked(detectOllamaModels);
const detectToolCapable = vi.mocked(detectOllamaToolCapableModels);

/**
 * Mirrors the hook's own constants: OLLAMA_POLL_INTERVAL_MS is 30s and
 * OLLAMA_POLL_MAX_INTERVAL_MS is 10 min, i.e. 20x the base. These are pinned
 * as literals on purpose — the schedule is a product decision, so retuning the
 * constants should fail here and force the table below to be revisited, not
 * quietly pass against whatever the new numbers happen to be.
 */
const BASE = 30_000;
const CAP = 20 * BASE;

let hidden = false;

function unreachable() {
  detectModels.mockResolvedValue({ isRunning: false, availableModels: [] });
}

function reachable(models: string[] = ["llama3.1"]) {
  detectModels.mockResolvedValue({ isRunning: true, availableModels: models });
  detectToolCapable.mockResolvedValue(models);
}

function rejecting() {
  detectModels.mockRejectedValue(new Error("probe blew up"));
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function setHidden(next: boolean) {
  hidden = next;
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

function mount() {
  const getBaseUrl = () => "http://127.0.0.1:11434";
  return renderHook(() => useDetectedOllamaModels(getBaseUrl));
}

/** Probe count, so assertions read as "one more probe happened". */
function probes() {
  return detectModels.mock.calls.length;
}

/** Asserts the next probe lands exactly `gap` ms later, not a tick sooner. */
async function expectNextProbeAfter(gap: number) {
  const before = probes();
  await advance(gap - 1);
  expect(probes()).toBe(before);
  await advance(1);
  expect(probes()).toBe(before + 1);
}

describe("useDetectedOllamaModels", () => {
  // Restored narrowly rather than through a blanket vi.restoreAllMocks(): the
  // global setup installs several vi.fn() stubs (fetch, matchMedia,
  // scrollIntoView) whose implementations a suite-level restore would strip —
  // see the warning on the ResizeObserver stub in src/test/setup.ts.
  let hiddenSpy: MockInstance<() => boolean>;

  beforeEach(() => {
    hidden = false;
    hiddenSpy = vi
      .spyOn(document, "hidden", "get")
      .mockImplementation(() => hidden);
    vi.useFakeTimers();
    detectToolCapable.mockResolvedValue([]);
  });

  afterEach(() => {
    hiddenSpy.mockRestore();
  });

  it("backs off 30s -> 1m -> 2m -> 4m -> 8m, then pins at the 10m cap", async () => {
    unreachable();
    mount();
    await advance(0);
    expect(probes()).toBe(1);

    for (const gap of [
      BASE, // 30s
      2 * BASE, // 1m
      4 * BASE, // 2m
      8 * BASE, // 4m
      16 * BASE, // 8m
      CAP, // 10m — 16m doubled would overshoot, so the cap holds
      CAP, // and keeps holding
    ]) {
      await expectNextProbeAfter(gap);
    }
  });

  it("returns to the base interval once Ollama answers", async () => {
    unreachable();
    mount();
    await advance(0);
    await expectNextProbeAfter(BASE);
    await expectNextProbeAfter(2 * BASE);

    reachable();
    await expectNextProbeAfter(4 * BASE);
    await expectNextProbeAfter(BASE);
    await expectNextProbeAfter(BASE);
  });

  it("stops probing entirely while the tab is hidden", async () => {
    unreachable();
    mount();
    await advance(0);
    const before = probes();

    await setHidden(true);
    await advance(20 * BASE);
    expect(probes()).toBe(before);
  });

  it("resumes with the delay that was left, not a probe per visibilitychange", async () => {
    unreachable();
    mount();
    await advance(0);
    const before = probes();

    await advance(BASE / 3);
    await setHidden(true);
    await advance(BASE / 3);
    await setHidden(false);
    // Coming back is not itself a reason to probe.
    expect(probes()).toBe(before);

    await expectNextProbeAfter(BASE / 3);
  });

  it("probes on return when the interval already elapsed while hidden", async () => {
    unreachable();
    mount();
    await advance(0);

    await setHidden(true);
    await advance(5 * BASE);
    const before = probes();

    await setHidden(false);
    await advance(0);
    expect(probes()).toBe(before + 1);
  });

  it("keeps one chain when the tab flips mid-probe", async () => {
    unreachable();
    let release: (value: {
      isRunning: boolean;
      availableModels: string[];
    }) => void = () => {};
    detectModels.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );

    mount();
    await advance(0);
    expect(probes()).toBe(1);

    // The flip lands while the first probe is still unresolved.
    await setHidden(true);
    await setHidden(false);
    expect(probes()).toBe(1);

    await act(async () => {
      release({ isRunning: false, availableModels: [] });
    });

    // Two chains would each schedule their own follow-up; one probe per
    // interval, on the backoff schedule, means the guard held.
    await expectNextProbeAfter(BASE);
    await expectNextProbeAfter(2 * BASE);
  });

  it("holds its schedule when the wall clock steps backwards", async () => {
    unreachable();
    mount();
    await advance(0);

    await advance(BASE / 3);
    await setHidden(true);
    vi.setSystemTime(Date.now() - 5 * 60_000);
    await setHidden(false);

    // 10s of the 30s cycle was spent, so 20s remain — step or no step.
    await expectNextProbeAfter((2 * BASE) / 3);
  });

  it("escalates the backoff when a probe rejects", async () => {
    // Unreachable through ollama-utils today, which catches its own fetch
    // failures. Pinned so a refactor that lets one reject can't leave the
    // schedule retrying at the last delay forever.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    rejecting();
    mount();
    await advance(0);
    expect(probes()).toBe(1);

    await expectNextProbeAfter(BASE);
    await expectNextProbeAfter(2 * BASE);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("stops probing after unmount", async () => {
    unreachable();
    const { unmount } = mount();
    await advance(0);
    const before = probes();

    unmount();
    await advance(20 * BASE);
    expect(probes()).toBe(before);
  });
});
