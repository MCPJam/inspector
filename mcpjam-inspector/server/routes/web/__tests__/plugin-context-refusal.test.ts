import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  admission: vi.fn(),
  getPersistent: vi.fn(),
}));
vi.mock("../../../services/plugin-host/admission.js", async (original) => ({
  ...(await original<
    typeof import("../../../services/plugin-host/admission.js")
  >()),
  admitPluginWorkspace: f.admission,
}));
vi.mock("../../../services/plugin-host/instances.js", () => ({
  pluginInstances: { getPersistent: f.getPersistent },
}));
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "fixture-bearer",
}));
vi.mock("../../../utils/tool-approval-token.js", () => ({
  toolApprovalSubjectFromAuthHeader: () => "verified-subject",
}));
import routes from "../plugin-instances";
import { PluginInvocationError } from "../../../services/plugin-host/invocation";
import { PluginModelContextError } from "../../../../shared/plugin-model-context";

const app = new Hono().route("/api/web/apps/plugin-instances", routes);
const update = (path: string, padding = 0) =>
  app.request(`/api/web/apps/plugin-instances/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer fixture",
    },
    body: JSON.stringify({
      projectId: "project",
      pluginWorkspace: { version: 1, workspaceId: "workspace" },
      instanceToken: "t".repeat(43),
      operationId: "8a0f0c1e-0b7e-4bfa-9f5e-0f0f0f0f0f0f",
      sequence: 1,
      params: { content: [{ type: "text", text: "x".repeat(padding) }] },
    }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  f.admission.mockResolvedValue({
    actorId: "actor",
    projectId: "project",
    revalidate: vi.fn(),
  });
});

describe("App context refusals keep their code", () => {
  it("answers an update over a budget with 413 and the sizes for Logs", async () => {
    f.getPersistent.mockRejectedValue(
      new PluginModelContextError("PLUGIN_CONTEXT_TOO_LARGE", {
        budget: "updateMaxBytes",
        actual: 300_000,
        allowed: 262_144,
      }),
    );
    const response = await update("context");
    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body).toMatchObject({
      code: "PLUGIN_CONTEXT_TOO_LARGE",
      description: expect.stringContaining("last accepted context stays"),
    });
    expect(body.diagnostics).toEqual([
      expect.objectContaining({
        code: "PLUGIN_CONTEXT_TOO_LARGE",
        details: {
          budget: "updateMaxBytes",
          actual: 300_000,
          allowed: 262_144,
        },
      }),
    ]);
  });

  it.each([
    ["INSTANCE_CONTEXT_RATE_LIMITED", 429],
    ["INVALID_INSTANCE_CONTEXT", 413],
    ["INSTANCE_CONTEXT_TOO_LARGE", 413],
    ["PLUGIN_CONTEXT_MEMORY_LIMIT", 503],
  ])("answers a stored-context %s refusal with %i", async (code, status) => {
    f.getPersistent.mockRejectedValue(new PluginInvocationError(code));
    const response = await update("context");
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({
      code,
      diagnostics: [expect.objectContaining({ code })],
    });
  });

  it("keeps an unknown outcome unknown", async () => {
    f.getPersistent.mockRejectedValue(
      new PluginInvocationError("INSTANCE_CONTEXT_RATE_LIMITED", true),
    );
    const response = await update("context");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ outcomeUnknown: true });
  });
});

describe("the instance router's own body limit", () => {
  const over = 600 * 1024;
  it("leaves both context updates to webBodyLimit", async () => {
    f.getPersistent.mockRejectedValue(
      new PluginInvocationError("INSTANCE_CONTEXT_RATE_LIMITED"),
    );
    // The retained App route reached its handler past 512 KiB.
    expect((await update("context", over)).status).toBe(429);
    // So did the model App route: it refuses an unknown App, not the size.
    const model = await update("model/context", over);
    expect(await model.json()).toMatchObject({ code: "MODEL_APP_UNAVAILABLE" });
  });

  it("still caps every other instance route at 512 KiB", async () => {
    const response = await update("context/read", over);
    expect(response.status).not.toBe(200);
    expect(f.getPersistent).not.toHaveBeenCalled();
  });
});
