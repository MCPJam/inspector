import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("starts retained upload cleanup from the real hosted app without a local journal", async () => {
  vi.resetModules();
  vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("ELECTRON_APP", "");
  vi.stubEnv("MCPJAM_WORKOS_SESSION_SECRET", "test-workos-session-secret");
  vi.stubEnv("WORKOS_CLIENT_ID", "client_123");
  const { pluginFormFileGrants } =
    await import("../services/plugin-host/form-file-grants.js");
  const start = vi
    .spyOn(pluginFormFileGrants, "start")
    .mockResolvedValue(undefined);
  const { createHonoApp } = await import("../app.js");
  await createHonoApp();
  expect(start).toHaveBeenCalledExactlyOnceWith(false);
}, 120_000);
