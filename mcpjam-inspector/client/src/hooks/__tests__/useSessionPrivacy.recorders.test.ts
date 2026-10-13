/**
 * `useSessionPrivacy` against the real policy module and a recording
 * posthog-js stand-in: what the recorder is told, in what order, as the
 * session's organizations change.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrivacyInputs } from "@/lib/session-privacy";

const { usePostHog, server } = vi.hoisted(() => ({
  usePostHog: vi.fn(),
  /** What `telemetryPrivacy:getContext` answers right now; `undefined` = not yet. */
  server: { answer: undefined as unknown },
}));
vi.mock("posthog-js/react", () => ({ usePostHog }));
vi.mock("convex/react", () => ({
  useQueries: (queries: Record<string, unknown>) =>
    queries.policy ? { policy: server.answer } : {},
}));
vi.mock("@sentry/react", () => ({
  init: vi.fn(),
  getClient: vi.fn(() => undefined),
  addIntegration: vi.fn(),
  replayIntegration: vi.fn(),
  browserTracingIntegration: vi.fn(),
}));

/** Records what posthog-js is asked to do, and with which profile. */
function recordingPosthog() {
  const log: string[] = [];
  return {
    log,
    startSessionRecording: vi.fn(() => log.push("start")),
    stopSessionRecording: vi.fn(() => log.push("stop")),
    set_config: vi.fn((config: Record<string, unknown>) =>
      log.push(config.mask_all_text === true ? "masked" : "full"),
    ),
  };
}

async function setup(surface: "hosted" | "desktop" | "npx") {
  vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
  if (surface === "hosted") vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
  if (surface === "desktop") {
    vi.stubEnv("PROD", true);
    vi.stubGlobal("isElectron", true);
  }
  vi.resetModules();
  const privacy = await import("@/lib/session-privacy");
  const { useSessionPrivacy } = await import("../useSessionPrivacy");
  const posthog = recordingPosthog();
  usePostHog.mockReturnValue(posthog);

  // The backend's recording answer per organization in view.
  const answers: Record<string, "full" | "masked" | "off"> = {
    org_plain: "full",
    org_private: "masked",
    org_replay_off: "off",
  };
  const levelFor = (
    activeOrganizationId: string,
    overrides: Partial<SessionPrivacyInputs> = {},
  ) =>
    privacy.resolveSessionPrivacy({
      surface: privacy.recordingSurface(),
      sharedLink: false,
      recording: answers[activeOrganizationId],
      ...overrides,
    });
  const hook = renderHook(
    ({ level }: { level: ReturnType<typeof levelFor> }) =>
      useSessionPrivacy(level),
    {
      initialProps: {
        level: levelFor("org_plain", { recording: undefined }),
      },
    },
  );
  return { privacy, posthog, levelFor, hook };
}

describe("useSessionPrivacy with the real recorders", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/servers");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("hosted: nothing records until the backend answers", async () => {
    const { posthog, levelFor, hook } = await setup("hosted");
    expect(posthog.startSessionRecording).not.toHaveBeenCalled();

    // Pending put the masked profile in place without starting anything.
    expect(posthog.log).toEqual(["masked"]);

    hook.rerender({ level: levelFor("org_plain") });
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(posthog.log).toEqual(["masked", "full", "start"]);
  });

  it("switching into an organization with enterprise privacy never records it unmasked", async () => {
    const { posthog, levelFor, hook } = await setup("hosted");
    hook.rerender({ level: levelFor("org_plain") });
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    posthog.log.length = 0;

    hook.rerender({ level: levelFor("org_private") });

    // Synchronous, in the commit that switched: stop under the full profile,
    // reconfigure, and keep recording stopped.
    expect(posthog.log).toEqual(["stop", "masked"]);
  });

  it("switching back waits for the settle period before recording", async () => {
    const { posthog, levelFor, hook } = await setup("hosted");
    hook.rerender({ level: levelFor("org_private") });
    posthog.log.length = 0;

    hook.rerender({ level: levelFor("org_plain") });
    expect(posthog.log).toEqual([]);

    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(posthog.log).toEqual(["full", "start"]);
  });

  it("a backend that never answers is never recorded", async () => {
    // It could be an organization with replay off: only an answer can say.
    const { posthog, levelFor, hook } = await setup("hosted");
    hook.rerender({
      level: levelFor("org_plain", { recording: undefined }),
    });
    await act(async () => {
      vi.advanceTimersByTime(60 * 60 * 1000);
    });

    expect(posthog.startSessionRecording).not.toHaveBeenCalled();
    expect(posthog.log).not.toContain("full");
  });

  it("desktop: never records even after the backend answers", async () => {
    const { posthog, levelFor, hook } = await setup("desktop");
    expect(posthog.log).toEqual(["masked"]);
    hook.rerender({ level: levelFor("org_plain") });
    expect(posthog.log).toEqual(["masked"]);
  });

  it("replay off: never starts, and a running recording stops in the same commit", async () => {
    const { posthog, levelFor, hook } = await setup("hosted");
    hook.rerender({ level: levelFor("org_replay_off") });
    expect(posthog.startSessionRecording).not.toHaveBeenCalled();

    // Leaving `off` waits out the settle period before recording in full.
    hook.rerender({ level: levelFor("org_plain") });
    expect(posthog.startSessionRecording).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(posthog.log.at(-1)).toBe("start");
    posthog.log.length = 0;

    hook.rerender({ level: levelFor("org_replay_off") });
    expect(posthog.log).toEqual(["stop", "masked"]);

    // Off does not time out into masked recording.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(posthog.log).toEqual(["stop", "masked"]);
  });

  it("desktop: replay off is honoured too", async () => {
    const { posthog, levelFor, hook } = await setup("desktop");
    hook.rerender({ level: levelFor("org_replay_off") });
    expect(posthog.startSessionRecording).not.toHaveBeenCalled();
  });

  it("npx: recording remains off", async () => {
    const { posthog, levelFor, hook } = await setup("npx");
    hook.rerender({ level: levelFor("org_private") });
    expect(posthog.log).toEqual(["masked"]);
  });
});

describe("useSessionPrivacy composed with the policy subscription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/servers");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.resetModules();
    server.answer = undefined;
  });

  /** App's wiring, minus remembered `off`: the subscription feeds the level. */
  async function setupComposed() {
    vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.resetModules();
    const privacy = await import("@/lib/session-privacy");
    const { useSessionPrivacy } = await import("../useSessionPrivacy");
    const { useTelemetryPrivacyContext } =
      await import("../useTelemetryPrivacyContext");
    const posthog = recordingPosthog();
    usePostHog.mockReturnValue(posthog);
    const hook = renderHook(
      ({ membershipKey }: { membershipKey: string }) => {
        const policy = useTelemetryPrivacyContext({
          enabled: true,
          actor: "user_A",
          membershipKey,
          projectIds: [],
          organizationIds: ["org_plain"],
        });
        useSessionPrivacy(
          privacy.resolveSessionPrivacy({
            surface: privacy.recordingSurface(),
            sharedLink: false,
            recording: policy.answered ? policy.policy?.recording : undefined,
          }),
          { permissionKey: policy.scope },
        );
      },
      { initialProps: { membershipKey: "org_plain:owner:0" } },
    );
    return { privacy, posthog, hook };
  }

  it("joining an organization with replay off stops recording until the new answer", async () => {
    server.answer = { recording: "full", identity: "full", content: "full" };
    const { privacy, posthog, hook } = await setupComposed();
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(posthog.log.at(-1)).toBe("start");
    posthog.log.length = 0;

    // The membership reload drops the answer; the new one does not come.
    server.answer = undefined;
    await act(async () => {
      hook.rerender({ membershipKey: "org_off:member:0,org_plain:owner:0" });
    });
    expect(privacy.currentSessionPrivacy()).toBe("pending");
    expect(posthog.log).toEqual(["stop", "masked"]);

    await act(async () => {
      vi.advanceTimersByTime(60 * 60 * 1000);
    });
    expect(posthog.log).toEqual(["stop", "masked"]);

    // When it does come, it is off: still nothing records.
    server.answer = {
      recording: "off",
      identity: "id_only",
      content: "strict",
    };
    await act(async () => {
      hook.rerender({ membershipKey: "org_off:member:0,org_plain:owner:0" });
    });
    expect(privacy.currentSessionPrivacy()).toBe("off");
    expect(posthog.startSessionRecording).toHaveBeenCalledTimes(1);
  });
});
