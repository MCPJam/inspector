import { describe, expect, it, vi } from "vitest";
import {
  buildHelpMenu,
  desktopDiagnosticsText,
  probeLocalServer,
} from "./desktop-help-menu";

const snapshot = {
  run_id: "8f9d2c1e-4b7a-4d1e-9a3c-2f1e0d9c8b7a",
  auth: "signed_in",
  startup_stage: "app_load/session_refresh_failed",
  renderer_context_stale: true,
  activity: [{ kind: "oauth_callback", url: "https://secret.example/cb" }],
};

describe("desktopDiagnosticsText", () => {
  it("copies the named fields only, never the activity history", () => {
    const text = desktopDiagnosticsText({
      appVersion: "3.23.1",
      electronVersion: "39.2.0",
      os: "win32-10.0.26100",
      snapshot,
      localServer: { result: "ok", latencyMs: 12 },
    });
    expect(text).toBe(
      [
        "MCPJam desktop diagnostics",
        "Version: 3.23.1",
        "Electron: 39.2.0",
        "OS: win32-10.0.26100",
        "Startup stage: app_load/session_refresh_failed",
        "Sign-in: signed_in",
        "Window: not responding",
        "Local server: reachable, 12 ms",
        "Run ID: 8f9d2c1e-4b7a-4d1e-9a3c-2f1e0d9c8b7a",
      ].join("\n"),
    );
    expect(text).not.toContain("secret");
  });

  it("prints unknown for anything that is not a short closed value", () => {
    const text = desktopDiagnosticsText({
      appVersion: "3.23.1",
      electronVersion: "39.2.0",
      os: "darwin-25.1.0",
      snapshot: { startup_stage: "see https://x.example/?t=TOKEN", auth: 7 },
      localServer: { result: "not_started" },
    });
    expect(text).toContain("Startup stage: unknown");
    expect(text).toContain("Sign-in: unknown");
    expect(text).toContain("Local server: not started");
  });
});

describe("probeLocalServer", () => {
  it("keeps only the outcome and latency", async () => {
    let t = 1_000;
    const now = () => (t += 20);
    const ok = vi.fn<typeof fetch>(async () => new Response("{}"));
    expect(await probeLocalServer("http://127.0.0.1:6274", ok, now)).toEqual({
      result: "ok",
      latencyMs: 20,
    });
    expect(String(ok.mock.calls[0]![0])).toBe("http://127.0.0.1:6274/health");

    const failing = vi.fn<typeof fetch>(
      async () => new Response("{}", { status: 503 }),
    );
    expect(
      await probeLocalServer("http://127.0.0.1:6274", failing, now),
    ).toEqual({ result: "error", latencyMs: 20 });
  });

  it("tells a timeout from a refused connection, and a server not yet started", async () => {
    const timedOut = vi.fn<typeof fetch>(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    const refused = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await probeLocalServer("http://127.0.0.1:1", timedOut)).toEqual({
      result: "timeout",
    });
    expect(await probeLocalServer("http://127.0.0.1:1", refused)).toEqual({
      result: "network",
    });
    expect(await probeLocalServer(null)).toEqual({ result: "not_started" });
  });
});

describe("buildHelpMenu", () => {
  it("copies diagnostics and confirms, even when the server has not started", async () => {
    const writeClipboard = vi.fn();
    const confirm = vi.fn();
    const menu = buildHelpMenu({
      snapshot: () => snapshot,
      serverUrl: () => null,
      appVersion: () => "3.23.1",
      electronVersion: "39.2.0",
      os: "darwin-25.1.0",
      writeClipboard,
      confirm,
    });
    expect(menu.role).toBe("help");
    const submenu = menu.submenu as Array<{
      label: string;
      click: () => Promise<void>;
    }>;
    expect(submenu.map((item) => item.label)).toEqual(["Copy Diagnostics"]);
    await submenu[0]!.click();
    expect(writeClipboard).toHaveBeenCalledWith(
      expect.stringContaining("Local server: not started"),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("Diagnostics copied"),
    );
  });
});
