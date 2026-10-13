import { afterEach, describe, expect, it, vi } from "vitest";

const { init, on } = vi.hoisted(() => ({ init: vi.fn(), on: vi.fn() }));
vi.mock("@sentry/electron/main", () => ({
  init,
  getClient: () => ({ on }),
  IPCMode: { Both: 3 },
}));
import { initDesktopSentry } from "./strict-sentry";

afterEach(() => {
  vi.unstubAllEnvs();
  init.mockClear();
  on.mockClear();
});
describe("desktop diagnostic boundary", () => {
  it("routes renderer events through rebuilt diagnostics and drops other envelopes", () => {
    initDesktopSentry({ release: "3.16.0", packaged: true, root: "/trusted" });
    const options = init.mock.calls[0][0];
    const sentinel = "PRIVATE_SENTINEL";
    const hint = { attachments: [{ filename: sentinel }] };
    const event = options.beforeSend(
      {
        exception: { values: [{ type: "TypeError", value: sentinel }] },
        user: { email: sentinel },
      },
      hint,
    );
    expect(event.exception.values).toEqual([
      { type: "TypeError", value: "TypeError" },
    ]);
    expect(hint.attachments).toEqual([]);
    expect(options.attachScreenshot).toBe(false);
    expect(options.tracesSampleRate).toBe(0);
    const envelope = [
      { trace: { sentinel } },
      [
        [{ type: "attachment" }, sentinel],
        [{ type: "event" }, { message: sentinel }],
      ],
    ];
    on.mock.calls[0][1](envelope);
    expect(JSON.stringify(envelope)).not.toContain(sentinel);
    expect(envelope[1]).toHaveLength(1);
  });
  it.each(["1", "true"])("honors DO_NOT_TRACK=%s for all families", (value) => {
    vi.stubEnv("DO_NOT_TRACK", value);
    initDesktopSentry({ release: "3.16.0", packaged: true, root: "/trusted" });
    const options = init.mock.calls[0][0];
    expect(options.enabled).toBe(false);
    expect(options.beforeSend({}, {})).toBeNull();
    expect(options.beforeSendTransaction({}, {})).toBeNull();
  });
});
