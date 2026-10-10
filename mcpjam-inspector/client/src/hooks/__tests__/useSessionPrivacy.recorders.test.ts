/**
 * `useSessionPrivacy` against the real policy module and a recording
 * posthog-js stand-in: what the recorder is told, in what order, as the
 * session's organizations change.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrivacyInputs } from "@/lib/session-privacy";

const { usePostHog } = vi.hoisted(() => ({ usePostHog: vi.fn() }));
vi.mock("posthog-js/react", () => ({ usePostHog }));
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
  const answers: Record<string, "full" | "masked"> = {
    org_plain: "full",
    org_private: "masked",
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
    expect(posthog.log).toEqual(["masked", "full", "start"]);
  });

  it("switching into an organization with enterprise privacy never records it unmasked", async () => {
    const { posthog, levelFor, hook } = await setup("hosted");
    hook.rerender({ level: levelFor("org_plain") });
    posthog.log.length = 0;

    hook.rerender({ level: levelFor("org_private") });

    // Synchronous, in the commit that switched: stop under the full profile,
    // reconfigure, and only then record again.
    expect(posthog.log).toEqual(["stop", "masked", "start"]);
  });

  it("switching back records masked until the settle period has passed", async () => {
    const { posthog, levelFor, hook } = await setup("hosted");
    hook.rerender({ level: levelFor("org_private") });
    posthog.log.length = 0;

    hook.rerender({ level: levelFor("org_plain") });
    expect(posthog.log).toEqual([]);

    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(posthog.log).toEqual(["stop", "full", "start"]);
  });

  it("a backend that never answers is recorded masked", async () => {
    const { posthog, levelFor, hook } = await setup("hosted");
    hook.rerender({
      level: levelFor("org_plain", { recording: undefined }),
    });
    expect(posthog.startSessionRecording).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(posthog.log.at(-1)).toBe("start");
    expect(posthog.log).not.toContain("full");
  });

  it("desktop: masked for everyone, from the first render", async () => {
    const { posthog } = await setup("desktop");
    expect(posthog.log).toEqual(["masked", "start"]);
  });

  it("npx: off, the recorder is never touched", async () => {
    const { posthog, levelFor, hook } = await setup("npx");
    hook.rerender({ level: levelFor("org_private") });
    expect(posthog.log).toEqual([]);
  });
});
