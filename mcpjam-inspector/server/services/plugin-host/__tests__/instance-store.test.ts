import { describe, expect, it, vi } from "vitest";
import {
  createPluginInstanceControlPort,
  pluginInstanceIdentityHash,
} from "../instance-store.js";
const identity = {
  actorId: "fixture-actor",
  projectId: "fixture-project",
  workspaceId: "fixture-workspace",
  subject: "verified-subject",
};
describe("private instance store port", () => {
  it("binds every identity field without sending raw identity or bearer", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ control: null }), { status: 200 }),
    );
    const port = createPluginInstanceControlPort(identity, {
      env: {
        INSPECTOR_SERVICE_TOKEN: "synthetic-service-token",
        CONVEX_HTTP_URL: "https://example.invalid",
      },
      fetchImpl,
    })!;
    await expect(
      port.read("private-handle", AbortSignal.timeout(1000)),
    ).resolves.toBeNull();
    const [url, request] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://example.invalid/internal/v1/plugin-instance-controls",
    );
    const body = JSON.parse(request.body as string);
    expect(body.identityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.controlHash).toMatch(/^[a-f0-9]{64}$/);
    expect(request.body).not.toContain("private-handle");
    for (const value of Object.values(identity))
      expect(request.body).not.toContain(value);
    for (const key of Object.keys(identity))
      expect(
        pluginInstanceIdentityHash({ ...identity, [key]: "changed" }),
      ).not.toBe(pluginInstanceIdentityHash(identity));
  });
  it("requires service credentials when hosted and observes refusal", async () => {
    expect(
      createPluginInstanceControlPort(identity, { env: {}, hosted: true }),
    ).toBeUndefined();
    // A local install without a service token keeps controls in-process.
    expect(
      createPluginInstanceControlPort(identity, { env: {}, hosted: false }),
    ).toBeDefined();
    const port = createPluginInstanceControlPort(identity, {
      env: {
        INSPECTOR_SERVICE_TOKEN: "synthetic-service-token",
        CONVEX_HTTP_URL: "https://example.invalid",
      },
      fetchImpl: async () =>
        new Response('{"code":"INSTANCE_DENIED"}', { status: 403 }),
    })!;
    await expect(port.read("token", AbortSignal.timeout(1000))).rejects.toThrow(
      "INSTANCE_DENIED",
    );
  });
});
