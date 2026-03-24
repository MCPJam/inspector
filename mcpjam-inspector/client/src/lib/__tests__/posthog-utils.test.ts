import { beforeEach, describe, expect, it, vi } from "vitest";
import { options } from "../PosthogUtils";

describe("PosthogUtils", () => {
  beforeEach(() => {
    vi.stubGlobal("__APP_VERSION__", "2.0.13-test");
  });

  it("registers static telemetry properties on PostHog load", () => {
    const posthog = {
      register: vi.fn(),
    };

    options.loaded(posthog);

    expect(posthog.register).toHaveBeenCalledWith({
      environment: import.meta.env.MODE,
      platform: expect.any(String),
      version: "2.0.13-test",
    });
  });
});
