import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/apis/web/context", () => ({
  getApiAuthorizationHeader: vi.fn(async () => "Bearer owner"),
}));
vi.mock("@/lib/convex-site-url", () => ({
  getConvexSiteUrl: () => "https://example.convex.site",
}));
beforeEach(() => {
  vi.resetModules();
  vi.mocked(global.fetch).mockReset().mockResolvedValue(new Response("{}"));
});
for (const path of [
  "/api/v1/deletions",
  "/api/v1/deletions/request_1/cancel",
]) {
  it(`attaches the current bearer to ${path}`, async () => {
    const { authFetch } = await import("../session-token");
    await authFetch(path, { method: "POST" });
    const headers = new Headers(
      vi.mocked(global.fetch).mock.calls[0]?.[1]?.headers,
    );
    expect(headers.get("Authorization")).toBe("Bearer owner");
  });
}
it("does not attach a bearer to a foreign origin or similar path", async () => {
  const { authFetch } = await import("../session-token");
  await authFetch("https://evil.example/api/v1/deletions");
  await authFetch("/api/v1/deletions-export");
  for (const call of vi.mocked(global.fetch).mock.calls) {
    expect(new Headers(call[1]?.headers).has("Authorization")).toBe(false);
  }
});
