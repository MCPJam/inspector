import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrepareSandboxViewRequest } from "@mcpjam/sdk/widget-runtime";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), server: vi.fn() }));
vi.mock("@/lib/session-token", () => ({ authFetch: mocks.fetch }));
vi.mock("@/lib/config", () => ({ HOSTED_MODE: false }));
vi.mock("@/lib/apis/web/context", () => ({ buildServerRequest: mocks.server }));
import { MCPJAM_PLATFORM_SERVER_ID } from "@/shared/mcpjam-agent-widgets.js";
import { createSandboxViewServices } from "../sandbox-view-services";

const request: PrepareSandboxViewRequest = {
  viewInstanceId: "view", source: { serverId: "server", resourceUri: "ui://app", toolCallId: "call" },
  html: "<p>App</p>", policy: { permissive: false }, mode: "declared", hostOrigin: "http://localhost:5173",
};
const prepared = {
  admissionId: "admission", proxyUrl: "http://127.0.0.1:64001/admitted",
  htmlSha256: "a".repeat(64), expiresAt: Date.now() + 120_000,
};
beforeEach(() => {
  mocks.fetch.mockReset().mockResolvedValue({ ok: true, json: async () => prepared });
  mocks.server.mockReset().mockReturnValue({ projectId: "project", serverId: "server" });
});

describe("sandbox view API routing", () => {
  it("prepares through authenticated local API and preserves cancellation", async () => {
    const signal = new AbortController().signal;
    await createSandboxViewServices(() => false).prepareSandboxView(request, signal);
    expect(mocks.fetch).toHaveBeenCalledWith("/api/apps/mcp-apps/view-admissions", expect.objectContaining({ method: "POST", signal }));
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual(request);
    expect(mocks.server).not.toHaveBeenCalled();
  });

  it("adds authorized web context and releases through the original endpoint", async () => {
    let web = true;
    const service = createSandboxViewServices(() => web);
    await service.prepareSandboxView(request);
    expect(mocks.server).toHaveBeenCalledWith("server");
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toMatchObject({ projectId: "project", source: request.source });
    web = false;
    await service.releaseSandboxView({ admissionId: prepared.admissionId });
    expect(mocks.fetch).toHaveBeenLastCalledWith("/api/web/apps/mcp-apps/view-admissions/admission", expect.objectContaining({ method: "DELETE", body: JSON.stringify({ source: request.source, projectId: "project", serverId: "server" }) }));
  });

  it("uses the platform web route without resolving a synthetic saved server", async () => {
    await createSandboxViewServices(() => false).prepareSandboxView({ ...request, source: { ...request.source, serverId: MCPJAM_PLATFORM_SERVER_ID } });
    expect(mocks.fetch.mock.calls[0][0]).toBe("/api/web/apps/mcp-apps/view-admissions");
    expect(mocks.server).not.toHaveBeenCalled();
  });

  it("accepts only the admission-bound isolated localhost origin", async () => {
    const admissionId = "f25fbd38-3b88-4602-b52c-845cad7677d0";
    const result = { ...prepared, admissionId, proxyUrl: `http://${admissionId}.localhost:64001/admitted` };
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => result });
    await expect(createSandboxViewServices(() => false).prepareSandboxView(request)).resolves.toEqual(result);
  });

  it.each(["http://arbitrary.localhost:64001/admitted", "http://f25fbd38-3b88-4602-b52c-845cad7677d0.localhost:64001/admitted", "http://localhost:5173/admitted", "http://remote.example/admitted", "https://name:secret@example.test/admitted"])("rejects an unsafe prepared URL %s", async (proxyUrl) => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ ...prepared, proxyUrl }) });
    await expect(createSandboxViewServices(() => false).prepareSandboxView(request)).rejects.toThrow("Could not open this App securely");
    expect(mocks.fetch).toHaveBeenLastCalledWith("/api/apps/mcp-apps/view-admissions/admission", expect.objectContaining({ method: "DELETE" }));
  });
});

it("prepares hidden owned servers using captured context without global name lookup", async () => {
  mocks.server.mockImplementation(() => { throw new Error("No globally selected server"); });
  const context = { projectId: "owner-project", serverId: "hidden-owned-server" };
  const service = createSandboxViewServices(() => true, () => context);
  const source = { ...request.source, serverId: context.serverId };
  await service.prepareSandboxView({ ...request, source });
  expect(mocks.server).not.toHaveBeenCalled();
  expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toMatchObject({
    ...context, source,
  });
  context.projectId = "changed-after-open";
  await service.releaseSandboxView({ admissionId: prepared.admissionId });
  expect(JSON.parse(mocks.fetch.mock.calls.at(-1)![1].body)).toMatchObject({
    projectId: "owner-project", serverId: "hidden-owned-server", source,
  });
});
