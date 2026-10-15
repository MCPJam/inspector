import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { FullConfig } from "@playwright/test";
import { chmod, rm } from "node:fs/promises";
import smokeGuestSetup, {
  smokeGuestStorageFile,
  smokeGuestBearer,
} from "../../e2e/smoke-guest-setup";

const client = vi.hoisted(() => ({
  post: vi.fn(),
  storageState: vi.fn(),
  dispose: vi.fn(),
}));
const newContext = vi.hoisted(() => vi.fn());
vi.mock("@playwright/test", () => ({ request: { newContext } }));
vi.mock("node:fs/promises", () => ({ chmod: vi.fn(), rm: vi.fn() }));
const config = {
  projects: [
    {
      use: {
        baseURL: "http://localhost:6274",
        storageState: "/tmp/smoke-guest.json",
      },
    },
  ],
} as FullConfig;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PLAYWRIGHT_BASE_URL", "");
  vi.stubEnv("MCPJAM_SESSION_TOKEN", "local-access");
  vi.stubEnv("MCPJAM_E2E_GUEST_STATE_FILE", "");
  newContext.mockResolvedValue(client);
  client.post.mockResolvedValue({ ok: () => true });
  client.storageState.mockResolvedValue(undefined);
  client.dispose.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

it("mints once and saves the cookie jar and local-access marker for every worker", async () => {
  const cleanup = await smokeGuestSetup(config);
  expect(newContext).toHaveBeenCalledExactlyOnceWith({
    baseURL: "http://localhost:6274",
    extraHTTPHeaders: { Origin: "http://localhost:6274" },
    storageState: {
      cookies: [],
      origins: [
        {
          origin: "http://localhost:6274",
          localStorage: [
            { name: "mcpjam.local-access", value: "local-access" },
          ],
        },
      ],
    },
  });
  expect(client.post).toHaveBeenCalledExactlyOnceWith(
    "/api/web/guest-session",
    { data: {} },
  );
  expect(client.storageState).toHaveBeenCalledExactlyOnceWith({
    path: "/tmp/smoke-guest.json",
  });
  expect(client.dispose).toHaveBeenCalledOnce();
  expect(chmod).toHaveBeenCalledExactlyOnceWith("/tmp/smoke-guest.json", 0o600);
  await cleanup?.();
  expect(rm).toHaveBeenCalledExactlyOnceWith("/tmp/smoke-guest.json", {
    force: true,
  });
});

it("reports the actual setup refusal without retrying or disabling a limit", async () => {
  client.post.mockResolvedValue({ ok: () => false, status: () => 429 });
  await expect(smokeGuestSetup(config)).rejects.toThrow("HTTP 429");
  expect(client.post).toHaveBeenCalledOnce();
  expect(client.storageState).not.toHaveBeenCalled();
  expect(client.dispose).toHaveBeenCalledOnce();
});

it("disposes the request context if setup loses its connection", async () => {
  client.post.mockRejectedValue(new Error("Offline"));
  await expect(smokeGuestSetup(config)).rejects.toThrow("Offline");
  expect(client.dispose).toHaveBeenCalledOnce();
});

it("leaves deployed target authentication unchanged", async () => {
  vi.stubEnv("PLAYWRIGHT_BASE_URL", "https://staging.example.test");
  await smokeGuestSetup(config);
  expect(newContext).not.toHaveBeenCalled();
});

it("inherits the same private file path in workers with different process IDs", () => {
  const parent = smokeGuestStorageFile(123);
  expect(parent).toContain("mcpjam-smoke-guest-123.json");
  expect(smokeGuestStorageFile(456)).toBe(parent);
  expect(process.env.MCPJAM_E2E_GUEST_STATE_FILE).toBe(parent);
});

it("reuses the saved cookie for API-driven frame tests without minting a new identity", async () => {
  vi.stubEnv("MCPJAM_E2E_GUEST_STATE_FILE", "/tmp/private-state.json");
  client.post.mockResolvedValue({
    ok: () => true,
    json: async () => ({ token: "guest-token" }),
  });
  await expect(
    smokeGuestBearer("http://localhost:6274", "http://localhost:6274"),
  ).resolves.toBe("guest-token");
  expect(newContext).toHaveBeenCalledExactlyOnceWith({
    baseURL: "http://localhost:6274",
    storageState: "/tmp/private-state.json",
  });
  expect(client.dispose).toHaveBeenCalledOnce();
});
