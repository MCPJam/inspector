import { vi } from "vitest";

/**
 * posthog-js stand-in. `log` records every call in order, so a test can prove
 * the recorder stopped BEFORE its profile changed.
 */
export function posthogStub() {
  const log: string[] = [];
  let profile: unknown;
  const client = {
    log,
    profile: () => profile,
    startSessionRecording: vi.fn(() => log.push("start")),
    stopSessionRecording: vi.fn(() => log.push("stop")),
    set_config: vi.fn((config: Record<string, unknown>) => {
      profile = config.session_recording;
      log.push(`config:${config.mask_all_text === true ? "masked" : "full"}`);
    }),
  };
  return client;
}
