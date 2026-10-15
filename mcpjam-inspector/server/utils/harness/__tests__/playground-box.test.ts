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
  playgroundCredentialRefusal,
  resolvePlaygroundCredentialEnvironment,
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
  it("gives a plain cloud harness turn the conversation's box", () => {
    expect(playgroundHarnessBoxReason(turn())).toBe("conversation");
    expect(playgroundHarnessBoxReason(turn({ harnessId: "codex" }))).toBe(
      "conversation",
    );
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

describe("playgroundCredentialRefusal", () => {
  it("refuses a Cursor turn with no usable key, in the harness's own words", async () => {
    const refusal = await playgroundCredentialRefusal({
      harnessId: "cursor",
      secretEnv: undefined,
    });
    expect(refusal).toMatch(/CURSOR_API_KEY/);
  });

  it("passes a turn whose key is delivered, and a harness that needs none", async () => {
    expect(
      await playgroundCredentialRefusal({
        harnessId: "cursor",
        secretEnv: { CURSOR_API_KEY: "key_live" },
      }),
    ).toBeNull();
    expect(
      await playgroundCredentialRefusal({
        harnessId: "claude-code",
        secretEnv: undefined,
      }),
    ).toBeNull();
  });
});

describe("resolvePlaygroundCredentialEnvironment", () => {
  const key = (overrides: Record<string, unknown> = {}) => ({
    secretId: "sec_mine",
    name: "CURSOR_API_KEY",
    delivery: "brokered" as const,
    sharing: "user" as const,
    brokerHosts: ["api2.cursor.sh"],
    brokerHeader: "authorization",
    brokerTemplate: "Bearer {}",
    ...overrides,
  });
  const base = {
    bearer: "Bearer tok",
    projectId: "p1",
    hostId: "host_cursor",
    harnessId: "cursor",
  };

  it("finds or mints the hidden environment selecting the member's own key, and nothing else", async () => {
    const ensure = vi.fn(async () => ({ environmentId: "env_hidden" }));
    const listSecrets = vi.fn(async () => [key()]);
    const result = await resolvePlaygroundCredentialEnvironment({
      ...base,
      listSecrets: listSecrets as never,
      ensureAdhocEnvironment: ensure,
    });
    expect(result).toEqual({ ok: true, environmentId: "env_hidden" });
    expect(listSecrets).toHaveBeenCalledWith("tok", { projectId: "p1" });
    expect(ensure).toHaveBeenCalledWith({
      projectId: "p1",
      hostId: "host_cursor",
      secretSelection: { mode: "explicit", secretIds: ["sec_mine"] },
    });
  });

  it("with no usable key, says where to add it in the UI there is — never 'use an environment' — and mints nothing", async () => {
    for (const secrets of [[], [key({ sharing: "project" })]]) {
      const ensure = vi.fn(async () => ({ environmentId: "env_hidden" }));
      const result = await resolvePlaygroundCredentialEnvironment({
        ...base,
        listSecrets: (async () => secrets) as never,
        ensureAdhocEnvironment: ensure,
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.status).toBe(409);
      expect(result.message).toMatch(/Project Settings → Secrets/);
      expect(result.message).not.toMatch(/environment/i);
      expect(ensure).not.toHaveBeenCalled();
    }
  });

  it("a failed read or mint is a retryable refusal, not a box without a key", async () => {
    expect(
      await resolvePlaygroundCredentialEnvironment({
        ...base,
        listSecrets: (async () => {
          throw new Error("down");
        }) as never,
      }),
    ).toMatchObject({ ok: false, status: 502 });
    expect(
      await resolvePlaygroundCredentialEnvironment({
        ...base,
        listSecrets: (async () => [key()]) as never,
        ensureAdhocEnvironment: async () => {
          throw new Error("down");
        },
      }),
    ).toMatchObject({ ok: false, status: 502 });
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

  it("turns an older control plane's bare refusal code into a sentence", () => {
    const refused = describePlaygroundBoxRefusal("cursor", "credential", {
      status: 409,
      error: "environment_unavailable",
    });
    expect(refused.message).not.toMatch(/environment_unavailable/);
    expect(refused.message).toMatch(/environment .* is unavailable/);
    expect(
      describePlaygroundBoxRefusal("cursor", "credential", {
        status: 403,
        error: "not_owner",
      }).message,
    ).toMatch(/belongs to someone else/);
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
    // One last touch says the turn is over (so the box is evictable at the
    // member's cap), and then nothing.
    expect(touchMock.mock.calls.length).toBe(beats + 1);
    expect(
      (touchMock.mock.calls.at(-1) as unknown[] | undefined)?.[0],
    ).toMatchObject({
      sandboxRowId: "row",
      sandboxId: "sbx",
      ended: true,
    });
    await result.box.release();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(touchMock.mock.calls.length).toBe(beats + 1);
    // A conversation box is never torn down by its own turn.
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("stops beating when the turn's signal aborts, and leaves the box", async () => {
    provisionMock.mockResolvedValue({
      ok: true,
      value: { sandboxRowId: "row", sandboxId: "sbx" },
    });
    const turnAbort = new AbortController();
    const result = await acquirePlaygroundHarnessBox({
      ...args,
      signal: turnAbort.signal,
    });
    if (!result.ok) throw new Error("expected a box");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const beats = touchMock.mock.calls.length;
    expect(beats).toBeGreaterThan(0);
    turnAbort.abort();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(touchMock.mock.calls.length).toBe(beats);
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

  it("keeps the control plane's retry hint on a refusal", async () => {
    provisionMock.mockResolvedValue({
      ok: false,
      status: 503,
      error: "at capacity",
      code: "at_capacity",
      retryAfterMs: 2_500,
    });
    const result = await acquirePlaygroundHarnessBox(args);
    expect(result).toEqual({
      ok: false,
      refusal: {
        status: 503,
        error: "at capacity",
        code: "at_capacity",
        retryAfterMs: 2_500,
      },
    });
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
