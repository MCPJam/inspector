import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeUrlToBase } from "@sentry/core";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { electronBuildSurface } from "../shared/sentry-config";
import { dropUpdaterInstallSpawnRejection } from "./crash-reporting";
const { init, send } = vi.hoisted(() => ({ init: vi.fn(), send: vi.fn(async () => ({})) }));
vi.mock("@sentry/electron/main", () => ({ init, IPCMode: { Both: 3 }, makeElectronTransport: () => ({ send, flush: async () => true }) }));
import { initDesktopSentry } from "./strict-sentry";
afterEach(() => { vi.unstubAllEnvs(); init.mockClear(); send.mockClear(); });
describe("desktop diagnostic boundary", () => {
  it("preserves the packaged environment and build-owned debug metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-sentry-"));
    const debugId = "01234567-89ab-cdef-0123-456789abcdef";
    try {
      mkdirSync(join(root, ".vite/build"), { recursive: true });
      writeFileSync(
        join(root, ".vite/build/main.cjs"),
        `//# debugId=${debugId}`,
      );
      initDesktopSentry({ release: "3.16.0", packaged: true, root });
      const transport = init.mock.calls[0][0].transport({});
      await transport.send([
        {},
        [
          [
            { type: "event" },
            {
              debug_meta: {
                images: [{ code_file: "PRIVATE_SENTINEL", debug_id: debugId }],
              },
              exception: {
                values: [
                  {
                    type: "Error",
                    stacktrace: {
                      frames: [
                        {
                          filename: "app:///.vite/build/main.cjs",
                          lineno: 7,
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        ],
      ]);
      const serialized = JSON.stringify(send.mock.calls);
      expect(serialized).toContain('"environment":"prod"');
      expect(serialized).toContain('"platform":"javascript"');
      expect(serialized).toContain(
        `"dist":"${electronBuildSurface(process.platform)}"`,
      );
      expect(serialized).toContain(`"debug_id":"${debugId}"`);
      expect(serialized).toContain('"code_file":"app:///.vite/build/main.cjs"');
      expect(serialized).not.toContain("PRIVATE_SENTINEL");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains frames normalized by the installed Electron integration", async () => {
    initDesktopSentry({ release: "3.16.0", packaged: true, root: "/trusted" });
    const filename = normalizeUrlToBase("/trusted/.vite/build/main.cjs", "/trusted");
    const options = init.mock.calls[0][0];
    expect(options.beforeSend).toBe(dropUpdaterInstallSpawnRejection);
    const transport = options.transport({});
    await transport.send([{}, [[{ type: "event" }, {
      exception: { values: [{ type: "Error", stacktrace: { frames: [
        { filename, lineno: 7, function: "PRIVATE_SENTINEL" },
        { filename: "app:///customer/PRIVATE_SENTINEL.js", lineno: 8 },
      ] } }] },
    }]]]);
    expect(JSON.stringify(send.mock.calls)).not.toContain("PRIVATE_SENTINEL");
    expect(JSON.stringify(send.mock.calls)).toContain('"filename":"app:///.vite/build/main.cjs"');
    expect(JSON.stringify(send.mock.calls)).toContain('"lineno":7');
  });
  it("uses one final serializer for renderer errors and rejects unapproved envelopes", async () => {
    initDesktopSentry({ release: "3.16.0", packaged: true, root: "/trusted" });
    const options = init.mock.calls[0][0];
    expect(options.beforeSend).toBe(dropUpdaterInstallSpawnRejection);
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
