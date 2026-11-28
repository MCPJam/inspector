import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hosted: false,
  fetchVenue: vi.fn(),
  ensure: vi.fn(),
}));
vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  get HOSTED_MODE() {
    return mocks.hosted;
  },
}));
vi.mock("@/lib/local-harness-eval-venue", () => ({ fetchLocalHarnessEvalVenue: mocks.fetchVenue }));
vi.mock("@/lib/local-harness-consent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/local-harness-consent")>()),
  ensureLocalHarnessReady: mocks.ensure,
}));

import {
  localEvalVenueStartBlock,
  useLocalHarnessEvalVenues,
  type LocalEvalVenueRow,
} from "../use-local-harness-eval-venues";

const NOT_SET_UP = {
  ok: true,
  venue: { venue: "refused", refusal: "not-set-up", message: "Claude Code isn't set up for this project on this machine.", fix: "set-up" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hosted = false;
});

describe("where each harness client in a run would run", () => {
  it("asks once per distinct harness, and blocks Start until it hears back", async () => {
    let answer: (value: unknown) => void = () => {};
    mocks.fetchVenue.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const { result } = renderHook(() =>
      useLocalHarnessEvalVenues("project-1", ["claude-code", "claude-code"]),
    );
    expect(mocks.fetchVenue).toHaveBeenCalledTimes(1);
    expect(mocks.fetchVenue).toHaveBeenCalledWith("claude-code", "project-1", expect.any(AbortSignal));
    expect(result.current.startBlockedReason).toBe("Checking where Claude Code runs…");
    await act(async () => answer({ ok: true, venue: { venue: "local" } }));
    expect(result.current.rows).toEqual([{ harnessId: "claude-code", name: "Claude Code", state: { kind: "local" } }]);
    expect(result.current.startBlockedReason).toBeNull();
  });

  it("sets up in one click, then asks again", async () => {
    mocks.fetchVenue.mockResolvedValueOnce(NOT_SET_UP).mockResolvedValueOnce({ ok: true, venue: { venue: "local" } });
    mocks.ensure.mockImplementation(async (_project, _setup, _signal, progress: (message: string) => void) => {
      progress("Downloading Claude Code: 42%");
      return {};
    });
    const { result } = renderHook(() => useLocalHarnessEvalVenues("project-1", ["claude-code"]));
    await waitFor(() => expect(result.current.startBlockedReason).toBe("Set up Claude Code to start this run."));
    act(() => result.current.setUp("claude-code"));
    expect(mocks.ensure).toHaveBeenCalledWith("project-1", true, expect.any(AbortSignal), expect.any(Function), "claude-code");
    await waitFor(() => expect(result.current.rows[0]?.state).toEqual({ kind: "local" }));
    expect(mocks.fetchVenue).toHaveBeenCalledTimes(2);
  });

  it("keeps Add client's failure text when setup fails, with Retry", async () => {
    mocks.fetchVenue.mockResolvedValue(NOT_SET_UP);
    mocks.ensure.mockRejectedValue(new Error("Couldn't download Claude Code. Check your connection, then retry."));
    const { result } = renderHook(() => useLocalHarnessEvalVenues("project-1", ["claude-code"]));
    await waitFor(() => expect(result.current.rows[0]?.state.kind).toBe("refused"));
    act(() => result.current.setUp("claude-code"));
    await waitFor(() =>
      expect(result.current.rows[0]?.state).toEqual({
        kind: "setup-failed",
        message: "Couldn't download Claude Code. Check your connection, then retry.",
      }),
    );
    expect(result.current.startBlockedReason).toBe("Retry the Claude Code setup to start this run.");
  });

  it("offers a retry when the check itself fails, and leaves the launch to decide when it can't ask", async () => {
    mocks.fetchVenue.mockResolvedValueOnce({ ok: false, turnedOff: false }).mockResolvedValueOnce({ ok: false, turnedOff: true });
    const { result } = renderHook(() => useLocalHarnessEvalVenues("project-1", ["codex"]));
    await waitFor(() =>
      expect(result.current.rows[0]?.state).toEqual({
        kind: "refused",
        message: "Couldn't check whether Codex can run on this machine. Check your connection, then retry.",
        fix: "retry",
      }),
    );
    act(() => result.current.check("codex"));
    await waitFor(() => expect(result.current.rows[0]?.state).toEqual({ kind: "unknown" }));
    expect(result.current.startBlockedReason).toBeNull();
  });

  it("asks for a new sign-in when the check is refused for it", async () => {
    mocks.fetchVenue.mockResolvedValue({ ok: false, turnedOff: false, status: 401 });
    const { result } = renderHook(() => useLocalHarnessEvalVenues("project-1", ["claude-code"]));
    await waitFor(() =>
      expect(result.current.rows[0]?.state).toMatchObject({
        message: "Couldn't check whether Claude Code can run on this machine. Sign in again, then retry.",
      }),
    );
  });

  it("drops a setup started for another project when the project changes", async () => {
    let finishSetup: () => void = () => {};
    mocks.fetchVenue.mockResolvedValueOnce(NOT_SET_UP).mockResolvedValue({ ok: true, venue: { venue: "local" } });
    mocks.ensure.mockImplementation(() => new Promise<void>((resolve) => (finishSetup = resolve)));
    const { result, rerender } = renderHook(({ project }) => useLocalHarnessEvalVenues(project, ["claude-code"]), {
      initialProps: { project: "project-1" },
    });
    await waitFor(() => expect(result.current.rows[0]?.state.kind).toBe("refused"));
    act(() => result.current.setUp("claude-code"));
    mocks.fetchVenue.mockReset().mockResolvedValue(NOT_SET_UP);
    rerender({ project: "project-2" });
    await waitFor(() => expect(mocks.fetchVenue).toHaveBeenCalledWith("claude-code", "project-2", expect.any(AbortSignal)));
    await act(async () => finishSetup());
    expect(mocks.fetchVenue).not.toHaveBeenCalledWith("claude-code", "project-1", expect.anything());
    expect(result.current.rows[0]?.state).toMatchObject({ kind: "refused", fix: "set-up" });
  });

  it("asks nothing on the hosted app", () => {
    mocks.hosted = true;
    const { result } = renderHook(() => useLocalHarnessEvalVenues("project-1", ["claude-code"]));
    expect(mocks.fetchVenue).not.toHaveBeenCalled();
    expect(result.current.rows).toEqual([]);
    expect(result.current.startBlockedReason).toBeNull();
  });
});

describe("Start's reason while a client can't run", () => {
  const row = (name: string, state: LocalEvalVenueRow["state"]): LocalEvalVenueRow => ({
    harnessId: "codex",
    name,
    state,
  });

  it("names the one fix for one client", () => {
    expect(localEvalVenueStartBlock([row("Codex", { kind: "refused", message: "m", fix: "choose-another" })])).toBe(
      "Replace or remove Codex to start this run.",
    );
    expect(localEvalVenueStartBlock([row("Codex", { kind: "refused", message: "m", fix: "retry" })])).toBe(
      "Retry the check for Codex to start this run.",
    );
    expect(localEvalVenueStartBlock([row("Codex", { kind: "setting-up", progress: null })])).toBe(
      "Start is available once Codex is set up.",
    );
  });

  it("counts several", () => {
    expect(
      localEvalVenueStartBlock([
        row("Codex", { kind: "refused", message: "m", fix: "choose-another" }),
        row("Claude Code", { kind: "setup-failed", message: "m" }),
      ]),
    ).toBe("2 clients can't run here. Fix them above to start this run.");
  });

  it("doesn't block a client that runs here or in the cloud", () => {
    expect(localEvalVenueStartBlock([row("Codex", { kind: "local" }), row("Claude Code", { kind: "cloud" })])).toBeNull();
  });
});
