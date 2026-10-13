import { afterEach, describe, expect, it, vi } from "vitest";
const { init, send } = vi.hoisted(() => ({ init: vi.fn(), send: vi.fn(async () => ({})) }));
vi.mock("@sentry/electron/main", () => ({ init, IPCMode: { Both: 3 }, makeElectronTransport: () => ({ send, flush: async () => true }) }));
import { initDesktopSentry } from "./strict-sentry";
afterEach(() => { vi.unstubAllEnvs(); init.mockClear(); send.mockClear(); });
describe("desktop diagnostic boundary", () => {
  it("uses one final serializer for renderer errors and rejects unapproved envelopes", async () => {
    initDesktopSentry({ release: "3.16.0", packaged: true, root: "/trusted" });
    const options = init.mock.calls[0][0];
    expect(options.beforeSend).toBeUndefined();
    expect(options.beforeBreadcrumb).toBeUndefined();
    const transport = options.transport({});
    await transport.send([{ trace: "PRIVATE_SENTINEL" }, [
      [{ type: "event" }, { exception: { values: [{ type: "TypeError", value: "PRIVATE_SENTINEL" }] }, user: { email: "PRIVATE_SENTINEL" } }],
      [{ type: "attachment" }, "PRIVATE_SENTINEL"],
    ]]);
    expect(JSON.stringify(send.mock.calls)).toContain('"TypeError"');
    expect(JSON.stringify(send.mock.calls)).not.toContain("PRIVATE_SENTINEL");
    expect(options.attachScreenshot).toBe(false);
    expect(options.tracesSampleRate).toBe(0);
  });
  it.each(["1", "true"])("honors late DO_NOT_TRACK=%s for all families", async (value) => {
    initDesktopSentry({ release: "3.16.0", packaged: true, root: "/trusted" });
    const transport = init.mock.calls[0][0].transport({});
    vi.stubEnv("DO_NOT_TRACK", value);
    await transport.send([{}, [[{ type: "event" }, {}], [{ type: "transaction" }, {}]]]);
    expect(send).not.toHaveBeenCalled();
  });
});
