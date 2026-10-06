import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { provisionMock, touchMock, releaseMock, dataPlaneMock } = vi.hoisted(
  () => ({
    provisionMock: vi.fn(),
    touchMock: vi.fn(async () => "touched" as const),
    releaseMock: vi.fn(async () => {}),
    dataPlaneMock: vi.fn(() => true),
  }),
);

vi.mock("../../computers/control-plane-client.js", () => ({
  provisionPlaygroundTerminalSandbox: provisionMock,
  touchSandbox: touchMock,
  releaseSandbox: releaseMock,
  isComputersDataPlaneConfigured: dataPlaneMock,
}));

vi.mock("../../logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  acquirePlaygroundHarnessBox,
  describePlaygroundBoxRefusal,
  playgroundHarnessBoxReason,
  playgroundHarnessBoxUnavailableReason,
  releaseBoxWhenStreamEnds,
} from "../playground-box.js";

const turn = (overrides: Record<string, unknown> = {}) => ({
  harnessId: "claude-code" as string | undefined,
  localExecution: false,
  isScenarioSession: false,
  comparePane: false,
  ...overrides,
});

describe("playgroundHarnessBoxReason", () => {
  it("leaves a plain cloud harness turn on the personal computer", () => {
    expect(playgroundHarnessBoxReason(turn())).toBeNull();
    expect(playgroundHarnessBoxReason(turn({ harnessId: "codex" }))).toBeNull();
  });

  it("sends a harness that signs in with the member's own account to a box", () => {
    expect(playgroundHarnessBoxReason(turn({ harnessId: "cursor" }))).toBe(
      "credential",
    );
  });

  it("sends a compare column to a box of its own", () => {
    expect(playgroundHarnessBoxReason(turn({ comparePane: true }))).toBe(
      "compare",
    );
  });

  it("names the credential first when both apply", () => {
    expect(
      playgroundHarnessBoxReason(
        turn({ harnessId: "cursor", comparePane: true }),
      ),
    ).toBe("credential");
  });

  it("never applies to a turn with no harness, a local target, or a scenario", () => {
    for (const overrides of [
      { harnessId: undefined, comparePane: true },
      { harnessId: "cursor", localExecution: true },
      { harnessId: "cursor", isScenarioSession: true },
      { comparePane: true, localExecution: true },
      { comparePane: true, isScenarioSession: true },
    ]) {
      expect(playgroundHarnessBoxReason(turn(overrides))).toBeNull();
    }
  });
});

describe("playgroundHarnessBoxUnavailableReason", () => {
  afterEach(() => dataPlaneMock.mockReturnValue(true));

  it("is null on a computers data plane", () => {
    expect(playgroundHarnessBoxUnavailableReason("cursor", "credential")).toBe(
      null,
    );
  });

  it("names the harness and the reason when this server cannot run a box", () => {
    dataPlaneMock.mockReturnValue(false);
    expect(
      playgroundHarnessBoxUnavailableReason("cursor", "credential"),
    ).toMatch(/cursor harness signs in with your own account/);
    expect(
      playgroundHarnessBoxUnavailableReason("claude-code", "compare"),
    ).toMatch(/Compare columns each run the claude-code harness/);
  });
});

describe("describePlaygroundBoxRefusal", () => {
  it("keeps a cap's own sentence and 429", () => {
    expect(
      describePlaygroundBoxRefusal("cursor", "credential", {
        status: 429,
        error: "Live Playground computer limit (4) reached.",
        code: "user_terminal_cap",
      }),
    ).toEqual({
      status: 429,
      message: "Live Playground computer limit (4) reached.",
      code: "user_terminal_cap",
    });
  });

  it("keeps a 403 or 409 and says what could not start", () => {
    const refused = describePlaygroundBoxRefusal("cursor", "credential", {
      status: 409,
      error: "The environment is archived.",
    });
    expect(refused.status).toBe(409);
    expect(refused.message).toMatch(
      /couldn't be started: The environment is archived\./,
    );
    expect(
      describePlaygroundBoxRefusal("cursor", "credential", {
        status: 403,
        error: "not_owner",
      }).status,
    ).toBe(403);
  });

  it("answers capacity with a retry hint and anything else with a 502", () => {
    const capacity = describePlaygroundBoxRefusal("cursor", "compare", {
      status: 503,
      error: "at capacity",
    });
    expect(capacity.status).toBe(503);
    expect(capacity.message).toMatch(/Retry in a moment/);
    const other = describePlaygroundBoxRefusal("cursor", "compare", {
      status: 500,
      error: "boom",
    });
    expect(other.status).toBe(502);
    expect(other.message).not.toMatch(/Retry/);
    expect(
      describePlaygroundBoxRefusal("cursor", "compare", undefined).status,
    ).toBe(502);
  });
});

describe("acquirePlaygroundHarnessBox", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    provisionMock.mockReset();
    touchMock.mockClear();
    releaseMock.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  const args = {
    bearer: "tok",
    projectId: "p1",
    chatSessionId: "c1",
  };

  it("provisions through the control plane and hands back a binding", async () => {
    provisionMock.mockResolvedValue({
      ok: true,
      value: { sandboxRowId: "row", sandboxId: "sbx", workdir: "/home/user" },
    });
    const result = await acquirePlaygroundHarnessBox({
      ...args,
      projectEnvironmentId: "env_1",
    });
    expect(provisionMock).toHaveBeenCalledWith({
      bearer: "tok",
      projectId: "p1",
      chatSessionId: "c1",
      projectEnvironmentId: "env_1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.box.surface).toBe("playground");
    expect(result.box.binding).toEqual({
      sandboxRowId: "row",
      sandboxId: "sbx",
      runtimeKind: "terminal",
      workdir: "/home/user",
    });
    await result.box.release();
  });

  it("keeps the box alive across a turn longer than its idle TTL, then leaves it for the next turn", async () => {
    provisionMock.mockResolvedValue({
      ok: true,
      value: { sandboxRowId: "row", sandboxId: "sbx" },
    });
    const result = await acquirePlaygroundHarnessBox(args);
    if (!result.ok) throw new Error("expected a box");
    // A playground box idles out at 30 minutes; the heartbeat is a quarter.
    await vi.advanceTimersByTimeAsync(45 * 60_000);
    expect(touchMock.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(touchMock).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxRowId: "row", sandboxId: "sbx" }),
    );
    const beats = touchMock.mock.calls.length;
    await result.box.release();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(touchMock.mock.calls.length).toBe(beats);
    // A conversation box is never torn down by its own turn.
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("returns the control plane's refusal untouched", async () => {
    provisionMock.mockResolvedValue({
      ok: false,
      status: 429,
      error: "limit",
      code: "user_terminal_cap",
    });
    const result = await acquirePlaygroundHarnessBox(args);
    expect(result).toEqual({
      ok: false,
      refusal: { status: 429, error: "limit", code: "user_terminal_cap" },
    });
    expect(touchMock).not.toHaveBeenCalled();
  });

  it("turns a throw into a 502 refusal instead of failing the turn's setup", async () => {
    provisionMock.mockRejectedValue(new Error("socket hang up"));
    const result = await acquirePlaygroundHarnessBox(args);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.status).toBe(502);
  });
});

describe("releaseBoxWhenStreamEnds", () => {
  const streamOf = (chunks: string[], error?: Error) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          if (error) controller.error(error);
          else controller.close();
        },
      }),
      { status: 202, headers: { "x-test": "1" } },
    );

  it("passes the response through untouched when there is no box", async () => {
    const response = streamOf(["a"]);
    expect(releaseBoxWhenStreamEnds(response, undefined)).toBe(response);
  });

  it("holds the box until the body is fully read, then releases once", async () => {
    const release = vi.fn(async () => {});
    const wrapped = releaseBoxWhenStreamEnds(streamOf(["a", "b"]), { release });
    expect(wrapped.status).toBe(202);
    expect(wrapped.headers.get("x-test")).toBe("1");
    expect(release).not.toHaveBeenCalled();
    expect(await wrapped.text()).toBe("ab");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases when the reader walks away", async () => {
    const release = vi.fn(async () => {});
    const wrapped = releaseBoxWhenStreamEnds(streamOf(["a", "b"]), { release });
    await wrapped.body!.cancel("client went away");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases when the stream errors, and still surfaces the error", async () => {
    const release = vi.fn(async () => {});
    const wrapped = releaseBoxWhenStreamEnds(
      streamOf(["a"], new Error("engine died")),
      { release },
    );
    await expect(wrapped.text()).rejects.toThrow("engine died");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases at once for a response with no body", () => {
    const release = vi.fn(async () => {});
    releaseBoxWhenStreamEnds(new Response(null, { status: 204 }), { release });
    expect(release).toHaveBeenCalledTimes(1);
  });
});
