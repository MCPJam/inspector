/**
 * Who `/stream/org/resolve` is told the caller is. The backend hands a local
 * runtime its decrypted key and decides from the request whether that is a
 * managed delivery (MCPJam's Inspector, holding the service credential) or an
 * export (a user's process), which an organization's export policy can deny.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestOrgProviderRuntime } from "../org-runtime-admission.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function resolveHeaders(): Promise<{ url: string; headers: Headers }> {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      ok: true,
      runtimeLocation: "cloud",
      providerKey: "custom:gateway",
    }),
  );
  await requestOrgProviderRuntime("https://convex.example/", {
    target: { projectId: "project_1" },
    providerKey: "custom:gateway",
    model: "custom:gateway:gpt-x",
    auth: { bearerToken: "user-token" },
  });
  const [url, init] = fetchMock.mock.calls[0]!;
  return { url: String(url), headers: new Headers(init?.headers) };
}

describe("requestOrgProviderRuntime caller identity", () => {
  it("presents the service credential beside the user's bearer", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
    const { url, headers } = await resolveHeaders();
    expect(url).toBe("https://convex.example/stream/org/resolve");
    expect(headers.get("x-inspector-service-token")).toBe("service-token");
    expect(headers.get("authorization")).toBe("Bearer user-token");
  });

  it("sends only the bearer from a build without the credential", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    const { headers } = await resolveHeaders();
    expect(headers.has("x-inspector-service-token")).toBe(false);
    expect(headers.get("authorization")).toBe("Bearer user-token");
  });
});
